import { snapshot, subscribe as valtioSubscribe } from "valtio/vanilla";
import { getRegisteredTarget } from "../identity";
import { applyMutations } from "../ops/applyMutations";
import { diffObjects } from "../ops/diff";
import { getOptions } from "../settings";
import { carriedOwnKeysOf } from "../utils/dataEntries";
import { admissionLane } from "../valtio/classify";
import { drainDeliveries, enqueueDelivery, prepareDelivery } from "./emitterDeliver";
import { hasListeners, targetOf } from "./emitterRegistry";
import type { Handle } from "../handle";

export interface Transaction {
	readonly handle: Handle;
}

const requireObjectSnapshot = (value: unknown): object => {
	if (value !== null && (typeof value === "object" || typeof value === "function")) return value;

	throw new Error("opshot: state snapshots must have an object root");
};

let currentTransaction: Transaction | undefined;

export const isTransactionOpen = (): boolean => currentTransaction !== undefined;

export const openTransaction = (handle: Handle): Transaction => {
	const transaction: Transaction = { handle };

	currentTransaction = transaction;

	return transaction;
};

export const closeTransaction = (_transaction: Transaction): void => {
	currentTransaction = undefined;
};

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
		const emitOn = getOptions(targetOf(handle.proxy.root))?.emitOn;

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

const emitRange = (handle: Handle, meta: unknown, channelId: object | undefined): void => {
	handle.hasPendingWrites = false;

	const from = handle.lastSnapshot;
	const to = snapshot(handle.proxy.root);

	if (from === to) {
		handle.lastSnapshot = to;

		return;
	}

	if (!hasListeners(handle)) {
		handle.lastSnapshot = to;

		return;
	}

	const ops = diffObjects(
		requireObjectSnapshot(reconcileUntracked(from, handle.proxy.root, new WeakSet())),
		requireObjectSnapshot(to),
	);

	handle.lastSnapshot = to;

	if (ops.length === 0) return;

	enqueueDelivery(prepareDelivery(handle, ops, meta, channelId));
	drainDeliveries();
};

export function emitWrites(handle: Handle): void {
	emitRange(handle, undefined, undefined);
}

export function emitTransactionWrites(handle: Handle, meta: unknown, channelId: object | undefined): void {
	emitRange(handle, meta, channelId);
}

export const rollbackTransaction = (transaction: Transaction): void => {
	const failures: Array<unknown> = [];
	const handle = transaction.handle;
	const restoreTarget = handle.lastSnapshot;

	try {
		const operations = diffObjects(
			requireObjectSnapshot(snapshot(handle.proxy.root)),
			requireObjectSnapshot(restoreTarget),
		);

		if (operations.length > 0) {
			applyMutations(handle.proxy.root, operations, "do");
		}

		handle.lastSnapshot = restoreTarget;
		handle.hasPendingWrites = false;
	} catch (error) {
		failures.push(error);
	}

	if (failures.length === 0) return;

	if (failures.length === 1) throw failures[0];

	throw new AggregateError(failures, "opshot: failures during rollback");
};
