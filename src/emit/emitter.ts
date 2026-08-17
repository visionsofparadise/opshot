import { snapshot, subscribe as valtioSubscribe } from "valtio/vanilla";
import { getRegisteredTarget } from "../identity";
import {
	beginOccupancyRefusals,
	copyOccupancyTables,
	markOccupancyRefusal,
	occupancyRefusalsOf,
	restoreOccupancyTables,
	syncHandleTables,
} from "../occupancy";
import { diffObjects } from "../ops/diff";
import { stampOperation } from "../ops/operation";
import { rollbackTransaction } from "../transact/rollback";
import { carriedOwnKeysOf } from "../utils/dataEntries";
import { admissionLane } from "../valtio/classify";
import { drainDeliveries, enqueueDelivery, prepareDelivery, type PendingDelivery } from "./emitterDeliver";
import { targetOf } from "./emitterRegistry";
import type { DirtyIndex, Handle } from "../handle";

export interface CapturedRange {
	readonly delivery: PendingDelivery | undefined;
	readonly writeError: Error | undefined;
}

export function scheduleFlush(handle: Handle): void {
	if (handle.isFlushScheduled) return;

	handle.isFlushScheduled = true;

	const generation = handle.flushGeneration;

	const run = (): void => {
		if (generation !== handle.flushGeneration) return;

		handle.isFlushScheduled = false;
		emitWrites(handle);
	};

	void Promise.resolve().then(() => {
		const emitOn = handle.emitOn;

		if (emitOn === undefined) {
			run();

			return;
		}

		emitOn(run);
	});
}

export function armWatch(handle: Handle): void {
	if (handle.disarmWatch !== undefined) return;

	handle.disarmWatch = valtioSubscribe(
		handle.proxy.root,
		() => {
			handle.hasPendingWrites = true;

			if (handle.isFlushHeld) return;

			scheduleFlush(handle);
		},
		true,
	);
}

const cloneSnapshotNode = (snap: object): object => {
	const clone: object = Array.isArray(snap) ? [] : (Object.create(Reflect.getPrototypeOf(snap)) as object);

	for (const key of carriedOwnKeysOf(snap)) {
		const descriptor = Reflect.getOwnPropertyDescriptor(snap, key);

		if (descriptor !== undefined) Object.defineProperty(clone, key, descriptor);
	}

	if (Array.isArray(snap)) (clone as Array<unknown>).length = snap.length;

	return clone;
};

const reconcileUntracked = (snap: object, live: object, seen: WeakSet<object>): object => {
	if (seen.has(live)) return snap;

	seen.add(live);

	let result: object | undefined;

	const written = (): object => {
		result ??= cloneSnapshotNode(snap);

		return result;
	};

	for (const key of carriedOwnKeysOf(live)) {
		const liveValue: unknown = Reflect.get(live, key);

		if (typeof liveValue !== "object" || liveValue === null) continue;

		if (admissionLane(liveValue) === "untracked") {
			if (Reflect.get(snap, key) === liveValue) continue;

			const snapChild: unknown = Reflect.get(snap, key);

			if (typeof snapChild !== "object" || snapChild === null) continue;

			if (getRegisteredTarget(snapChild) !== targetOf(liveValue)) continue;

			const descriptor = Reflect.getOwnPropertyDescriptor(live, key);

			if (descriptor === undefined || descriptor.get !== undefined || descriptor.set !== undefined) continue;

			Object.defineProperty(written(), key, {
				value: liveValue,
				enumerable: descriptor.enumerable,
				configurable: true,
			});

			continue;
		}

		const snapChild: unknown = Reflect.get(snap, key);

		if (typeof snapChild !== "object" || snapChild === null) continue;

		const reconciled = reconcileUntracked(snapChild, liveValue, seen);

		if (reconciled === snapChild) continue;

		Object.defineProperty(written(), key, {
			value: reconciled,
			enumerable: true,
			configurable: true,
		});
	}

	return result ?? snap;
};

const combinedRefusalOf = (refusals: ReadonlyArray<Error>): Error => {
	if (refusals.length === 1) {
		const only = refusals[0];

		if (only !== undefined) return only;
	}

	return new AggregateError(refusals, "opshot: dangerous occupancies were refused");
};

const captureRange = (
	handle: Handle,
	meta: unknown,
	channelId: object | undefined,
	kind: "write" | "transaction",
): CapturedRange => {
	handle.hasPendingWrites = false;

	const from = handle.lastSnapshot;
	const to = snapshot(handle.proxy.root);

	const occupancyBaseline = copyOccupancyTables(handle);
	const previousDirty = handle.lastDirty;
	const dirty: DirtyIndex = { edges: new WeakMap(), nodes: new WeakSet() };

	if (from !== to) handle.lastDirty = dirty;

	beginOccupancyRefusals(handle);

	if (from === to) syncHandleTables(handle);

	const ops =
		from === to ? [] : diffObjects(reconcileUntracked(from, handle.proxy.root, new WeakSet()), to, handle, dirty);

	const refusals = occupancyRefusalsOf(handle);

	if (kind === "transaction" && refusals.length > 0) {
		restoreOccupancyTables(handle, occupancyBaseline);
		handle.lastDirty = previousDirty;
		beginOccupancyRefusals(handle);
		rollbackTransaction(handle);

		throw combinedRefusalOf(refusals);
	}

	handle.lastSnapshot = to;

	if (ops.length > 0) {
		if (!handle.replaying) {
			for (const operation of ops) stampOperation(handle, operation);
		}

		handle.lastDirty = dirty;
	} else {
		handle.lastDirty = previousDirty;
	}

	return {
		delivery: ops.length > 0 ? prepareDelivery(handle, ops, meta, channelId, dirty) : undefined,
		writeError:
			kind === "write" && refusals.length > 0 ? markOccupancyRefusal(combinedRefusalOf(refusals)) : undefined,
	};
};

const deliverCaptured = (captured: CapturedRange): void => {
	if (captured.delivery !== undefined) enqueueDelivery(captured.delivery);

	drainDeliveries();
};

export function deliverCapturedRanges(ranges: ReadonlyArray<CapturedRange>): void {
	for (const captured of ranges) {
		if (captured.delivery !== undefined) enqueueDelivery(captured.delivery);
	}

	drainDeliveries();
}

const raiseWriteError = (handle: Handle, error: Error): void => {
	if (handle.onError !== undefined) handle.onError(error);
	else throw error;
};

const emitRange = (
	handle: Handle,
	meta: unknown,
	channelId: object | undefined,
	kind: "write" | "transaction",
): void => {
	const captured = captureRange(handle, meta, channelId, kind);

	deliverCaptured(captured);

	if (captured.writeError !== undefined) raiseWriteError(handle, captured.writeError);
};

export function captureWrites(handle: Handle): CapturedRange {
	return captureRange(handle, undefined, undefined, "write");
}

export function captureTransactionWrites(handle: Handle, meta: unknown, channelId: object | undefined): CapturedRange {
	return captureRange(handle, meta, channelId, "transaction");
}

export function emitWrites(handle: Handle): void {
	emitRange(handle, undefined, undefined, "write");
}

export function emitCapturedWrites(handle: Handle, captured: CapturedRange): void {
	deliverCaptured(captured);

	if (captured.writeError !== undefined) raiseWriteError(handle, captured.writeError);
}
