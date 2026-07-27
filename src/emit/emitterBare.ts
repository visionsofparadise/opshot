import { snapshot, subscribe as valtioSubscribe } from "valtio/vanilla";
import { getCyclicPath } from "../ops/cloneValue";
import { diffSnapshots } from "../ops/diff";
import { formatOperationPath } from "../ops/path";
import { deliver } from "./emitterDeliver";
import {
	getEmitter,
	getOrCreateEmitter,
	hasListeners,
	type EmitterRecord,
	type GroupListeners,
} from "./emitterRegistry";

const augmentBareCycleError = (error: unknown): Error | undefined => {
	const path = getCyclicPath(error);

	if (path === undefined) return undefined;

	return new Error(
		`opshot: a bare write created a cyclic value at ${formatOperationPath(path)}. Cycles cannot be tracked. This surfaced asynchronously because the write was not inside transact. Use transact for catchable cycle errors, ignore() for back-linked structures, or ids.`,
	);
};

export const requireObjectSnapshot = (value: unknown): object => {
	if (value !== null && (typeof value === "object" || typeof value === "function")) return value;

	throw new Error("opshot: state snapshots must have an object root");
};

export const armWatchdog = (record: EmitterRecord): void => {
	if (record.disarm !== undefined) return;

	record.lastReported = snapshot(record.target);
	record.disarm = valtioSubscribe(record.target, () => {
		emitBareFlush(record.target);
	});
};

export const disarmWatchdog = (record: EmitterRecord): void => {
	record.disarm?.();
	record.disarm = undefined;
};

const reportBareDiff = (record: EmitterRecord): void => {
	const current = snapshot(record.target);

	if (current === record.lastReported) return;

	const previous = record.lastReported;

	record.lastReported = current;

	if (!hasListeners(record)) return;

	try {
		const ops = diffSnapshots(requireObjectSnapshot(previous), requireObjectSnapshot(current));

		if (ops.length === 0) return;

		deliver(record, ops, undefined);
	} catch (error) {
		throw augmentBareCycleError(error) ?? error;
	}
};

export const settlePendingBare = (record: EmitterRecord): void => {
	reportBareDiff(record);
};

export function emitBareFlush(target: object): void {
	const record = getEmitter(target);

	if (record === undefined) return;

	reportBareDiff(record);
}

export function mintGroupedEmitter(target: object, groupListeners: GroupListeners): EmitterRecord {
	const record = getOrCreateEmitter(target, groupListeners);

	armWatchdog(record);

	return record;
}
