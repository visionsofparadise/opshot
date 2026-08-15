import { snapshot, subscribe as valtioSubscribe } from "valtio/vanilla";
import { applyMutations } from "../ops/applyMutations";
import { diffObjects } from "../ops/diff";
import { getOptions } from "../settings";
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

const emitRange = (handle: Handle, meta: unknown, channelId: object | undefined): void => {
	handle.hasPendingWrites = false;

	const from = handle.lastSnapshot;
	const to = snapshot(handle.proxy.root);

	handle.lastSnapshot = to;

	if (from === to) return;

	if (!hasListeners(handle)) return;

	const ops = diffObjects(requireObjectSnapshot(from), requireObjectSnapshot(to));

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
