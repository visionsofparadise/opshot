import { snapshot, subscribe as valtioSubscribe } from "valtio/vanilla";
import { getRegisteredTarget, registerSnapshotCopy } from "../identity";
import { diffObjects } from "../ops/diff";
import { stampOperation } from "../ops/operation";
import { carriedOwnKeysOf } from "../utils/dataEntries";
import { admissionLane } from "../valtio/classify";
import { drainDeliveries, enqueueDelivery, prepareDelivery, type PendingDelivery } from "./emitterDeliver";
import { targetOf } from "./emitterRegistry";
import type { DirtyIndex, Handle } from "../handle";
import type { Operation } from "../ops/operation";

export type CapturedRange = PendingDelivery | undefined;

function scheduleFlush(handle: Handle): void {
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

	registerSnapshotCopy(clone, getRegisteredTarget(snap) ?? targetOf(snap));

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

interface CaptureDiff {
	readonly to: object;
	readonly ops: Array<Operation>;
	readonly dirty: DirtyIndex;
}

const captureDiffOf = (handle: Handle, from: object): CaptureDiff => {
	const to = snapshot(handle.proxy.root);
	const dirty: DirtyIndex = { edges: new WeakMap(), nodes: new WeakSet() };

	if (from === to) return { to, ops: [], dirty };

	return {
		to,
		ops: diffObjects(reconcileUntracked(from, handle.proxy.root, new WeakSet()), to, handle, dirty),
		dirty,
	};
};

const captureRange = (handle: Handle, meta: unknown): CapturedRange => {
	handle.hasPendingWrites = false;

	const from = handle.lastSnapshot;
	const committed = captureDiffOf(handle, from);
	const ops = committed.ops;

	handle.lastSnapshot = committed.to;
	handle.internedThrough = handle.nextInternId - 1;

	if (ops.length > 0 && !handle.replaying) {
		for (const operation of ops) stampOperation(handle, operation);
	}

	return ops.length > 0 ? prepareDelivery(handle, ops, meta, committed.dirty) : undefined;
};

export function deliverCapturedRanges(ranges: ReadonlyArray<CapturedRange>): void {
	for (const captured of ranges) {
		if (captured !== undefined) enqueueDelivery(captured);
	}

	drainDeliveries();
}

const emitRange = (handle: Handle, meta: unknown): void => {
	const captured = captureRange(handle, meta);

	if (captured !== undefined) enqueueDelivery(captured);

	drainDeliveries();
};

export function captureBatchWrites(handle: Handle, meta: unknown): CapturedRange {
	return captureRange(handle, meta);
}

export function emitWrites(handle: Handle): void {
	emitRange(handle, undefined);
}
