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
import { rollbackTransaction } from "../transact/rollback";
import { carriedOwnKeysOf } from "../utils/dataEntries";
import { admissionLane } from "../valtio/classify";
import { drainDeliveries, enqueueDelivery, prepareDelivery } from "./emitterDeliver";
import { targetOf } from "./emitterRegistry";
import { requireObjectSnapshot } from "./requireObjectSnapshot";
import type { DirtyIndex, Handle } from "../handle";

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

export function releaseHold(handle: Handle, ownsHold: boolean): void {
	if (!ownsHold) return;

	handle.isFlushHeld = false;

	if (handle.hasPendingWrites) scheduleFlush(handle);
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

const emitRange = (
	handle: Handle,
	meta: unknown,
	channelId: object | undefined,
	kind: "write" | "transaction",
): void => {
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
		from === to
			? []
			: diffObjects(
					requireObjectSnapshot(reconcileUntracked(from, handle.proxy.root, new WeakSet())),
					requireObjectSnapshot(to),
					handle,
					dirty,
				);

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
		handle.lastDirty = dirty;
		enqueueDelivery(prepareDelivery(handle, ops, meta, channelId, dirty));
		drainDeliveries();
	} else {
		handle.lastDirty = previousDirty;
	}

	if (kind === "write" && refusals.length > 0) {
		const error = markOccupancyRefusal(combinedRefusalOf(refusals));

		if (handle.onError !== undefined) handle.onError(error);
		else throw error;
	}
};

export function emitWrites(handle: Handle): void {
	emitRange(handle, undefined, undefined, "write");
}

export function emitTransactionWrites(handle: Handle, meta: unknown, channelId: object | undefined): void {
	emitRange(handle, meta, channelId, "transaction");
}
