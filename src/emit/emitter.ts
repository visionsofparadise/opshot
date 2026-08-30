import { snapshot, subscribe as valtioSubscribe } from "valtio/vanilla";
import { diffObjects } from "../ops/diff";
import { stampOperation } from "../ops/operation";
import { drainDeliveries, enqueueDelivery, prepareDelivery, type PendingDelivery } from "./emitterDeliver";
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
		ops: diffObjects(from, to, handle, dirty),
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
