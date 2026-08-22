import { snapshot, subscribe as valtioSubscribe } from "valtio/vanilla";
import { getRegisteredTarget, isSameIdentity, registerSnapshotCopy } from "../identity";
import { annotateDepartureUndos, commitVends, evictDepartedClusters } from "../intern";
import { OccupancyRefusalError, createCaptureTables, syncHandleTables } from "../occupancy";
import { diffObjects } from "../ops/diff";
import { stampOperation } from "../ops/operation";
import { createOperationPath, liveAtPath, type OperationPath } from "../ops/path";
import { isObjectLike } from "../ops/predicates";
import { rollbackTransaction } from "../transact/rollback";
import { carriedOwnKeysOf } from "../utils/dataEntries";
import { admissionLane } from "../valtio/classify";
import { drainDeliveries, enqueueDelivery, prepareDelivery, type PendingDelivery } from "./emitterDeliver";
import { targetOf } from "./emitterRegistry";
import type { DirtyIndex, Handle } from "../handle";
import type { CaptureTables } from "../occupancy";
import type { Operation } from "../ops/operation";

export interface CapturedRange {
	readonly delivery: PendingDelivery | undefined;
	readonly writeError: Error | undefined;
}

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

const nodeAtSnapshotPath = (from: object, path: OperationPath): unknown => {
	let current: unknown = from;

	for (const segment of path) {
		if (!isObjectLike(current) || !Object.hasOwn(current, segment)) return undefined;

		current = Reflect.get(current, segment);
	}

	return current;
};

const restoredOccupantOf = (value: unknown): unknown =>
	isObjectLike(value) ? (getRegisteredTarget(value) ?? value) : value;

const holdsOccupant = (parent: object, key: string | number, occupant: unknown): boolean => {
	const parentRaw = targetOf(parent);

	if (!Object.hasOwn(parentRaw, key)) return false;

	const stored: unknown = Reflect.get(parentRaw, key);

	if (Object.is(stored, occupant)) return true;

	return isObjectLike(stored) && isObjectLike(occupant) && isSameIdentity(stored, occupant);
};

const revertRefusedPath = (handle: Handle, from: object, path: OperationPath): boolean => {
	const key = path[path.length - 1];

	if (key === undefined) return false;

	const parentPath = createOperationPath(path.slice(0, -1));
	const liveParent = liveAtPath(handle.proxy.root, parentPath);

	if (!isObjectLike(liveParent)) return true;

	const snapshotParent = nodeAtSnapshotPath(from, parentPath);

	if (
		isObjectLike(snapshotParent) &&
		(getRegisteredTarget(snapshotParent) ?? snapshotParent) === targetOf(liveParent) &&
		Object.hasOwn(snapshotParent, key)
	) {
		const restored = restoredOccupantOf(Reflect.get(snapshotParent, key));

		if (holdsOccupant(liveParent, key, restored)) return false;

		Reflect.set(liveParent, key, restored);

		return holdsOccupant(liveParent, key, restored);
	}

	Reflect.deleteProperty(liveParent, key);

	return !Object.hasOwn(targetOf(liveParent), key);
};

const revertRefusedPaths = (handle: Handle, from: object, paths: ReadonlyArray<OperationPath>): boolean => {
	let settled = true;

	for (const path of paths) {
		let container: OperationPath = path;

		while (container.length > 0 && !revertRefusedPath(handle, from, container)) {
			container = createOperationPath(container.slice(0, -1));
		}

		if (container.length === 0) settled = false;
	}

	return settled;
};

const occupancyRefusalOf = (refusals: ReadonlyArray<Error>): OccupancyRefusalError => {
	if (refusals.length === 1) {
		const only = refusals[0];

		if (only !== undefined) return new OccupancyRefusalError(only);
	}

	return new OccupancyRefusalError(new AggregateError(refusals, "opshot: dangerous occupancies were refused"));
};

interface CaptureDiff {
	readonly to: object;
	readonly ops: Array<Operation>;
	readonly dirty: DirtyIndex;
	readonly capture: CaptureTables;
}

const captureDiffOf = (handle: Handle, from: object): CaptureDiff => {
	const to = snapshot(handle.proxy.root);
	const dirty: DirtyIndex = { edges: new WeakMap(), nodes: new WeakSet() };
	const capture = handle.transactionCapture ?? createCaptureTables();

	if (from === to) {
		syncHandleTables(handle, capture);

		return { to, ops: [], dirty, capture };
	}

	return {
		to,
		ops: diffObjects(reconcileUntracked(from, handle.proxy.root, new WeakSet()), to, handle, dirty, capture),
		dirty,
		capture,
	};
};

interface SettledCapture {
	readonly diff: CaptureDiff;
	readonly refusals: ReadonlyArray<Error>;
}

const revertPassLimit = 64;

const settledCaptureOf = (handle: Handle, from: object, probe: CaptureDiff): SettledCapture => {
	const refusals = new Array<Error>();
	let pass = probe;

	for (let attempt = 0; attempt <= revertPassLimit; attempt++) {
		if (pass.capture.refusals.length === 0) return { diff: pass, refusals };

		refusals.push(...pass.capture.refusals);

		const settled = revertRefusedPaths(handle, from, pass.capture.refusedPaths);
		const next = captureDiffOf(handle, from);

		if (!settled) return { diff: next, refusals };

		pass = next;
	}

	return { diff: pass, refusals };
};

const captureRange = (
	handle: Handle,
	meta: unknown,
	channelId: object | undefined,
	kind: "write" | "transaction",
): CapturedRange => {
	handle.hasPendingWrites = false;

	const from = handle.lastSnapshot;
	const probe = captureDiffOf(handle, from);

	if (kind === "transaction" && probe.capture.refusals.length > 0) {
		rollbackTransaction(handle);

		throw occupancyRefusalOf(probe.capture.refusals);
	}

	const settled = settledCaptureOf(handle, from, probe);
	const refusals = settled.refusals;
	const committed = settled.diff;
	const ops = committed.ops;

	commitVends(handle, committed.capture);
	handle.lastSnapshot = committed.to;

	const evicted = evictDepartedClusters(handle);

	if (ops.length > 0) annotateDepartureUndos(handle, ops, evicted);

	if (ops.length > 0 && !handle.replaying) {
		for (const operation of ops) stampOperation(handle, operation);
	}

	return {
		delivery: ops.length > 0 ? prepareDelivery(handle, ops, meta, channelId, committed.dirty) : undefined,
		writeError: kind === "write" && refusals.length > 0 ? occupancyRefusalOf(refusals) : undefined,
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
