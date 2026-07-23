import { getUntracked } from "proxy-compare";
import { snapshot, subscribe as valtioSubscribe, unstable_getInternalStates } from "valtio/vanilla";

import { getRegisteredTarget } from "./identity";
import { getCyclicPath } from "./ops/cloneValue";
import { diffSnapshots } from "./ops/diff";
import type { Op } from "./ops/operation";
import { formatOperationPath } from "./ops/path";
import { getRegisteredWrapperTarget } from "./react/wrapperRegistry";

export type StateListener = (ops: ReadonlyArray<Op>, meta: unknown) => void;
export type GroupListener = (state: object, ops: ReadonlyArray<Op>, meta: unknown) => void;

export interface EmitterRecord {
	listeners: Set<StateListener>;
	groupListeners?: Set<GroupListener>;
	lastReported: object;
	disarm?: () => void;
	isMutating: boolean;
	readonly target: object;
}

const emitters = new WeakMap<object, EmitterRecord>();
const { proxyStateMap } = unstable_getInternalStates();

const isObjectLike = (value: unknown): value is object => value !== null && (typeof value === "object" || typeof value === "function");

export const augmentBareCycleError = (error: unknown): Error | undefined => {
	const path = getCyclicPath(error);

	if (path === undefined) return undefined;

	return new Error(
		`opshot: a bare write created a cyclic value at ${formatOperationPath(path)}. Cycles cannot be tracked. This surfaced asynchronously because the write was not inside transact. Use transact for catchable cycle errors, ignore() for back-linked structures, or ids.`,
	);
};

export function resolveEmitterTarget(state: object): object {
	let current: unknown = state;

	while (isObjectLike(current)) {
		if (proxyStateMap.has(current)) return current;

		const untracked = getUntracked(current);

		if (untracked !== null && untracked !== current) {
			current = untracked;

			continue;
		}

		const wrapperTarget = getRegisteredWrapperTarget(current);

		if (wrapperTarget !== undefined && wrapperTarget !== current) {
			current = wrapperTarget;

			continue;
		}

		const registeredTarget = getRegisteredTarget(current);

		if (registeredTarget !== undefined && registeredTarget !== current) {
			current = registeredTarget;

			continue;
		}

		break;
	}

	if (!isObjectLike(current) || !proxyStateMap.has(current)) throw new Error("opshot: expected a state object");

	return current;
}

export function getEmitter(state: object): EmitterRecord | undefined {
	return emitters.get(resolveEmitterTarget(state));
}

export const hasListeners = (record: EmitterRecord): boolean => record.listeners.size > 0 || (record.groupListeners?.size ?? 0) > 0;

const armWatchdog = (record: EmitterRecord): void => {
	if (record.disarm !== undefined) return;

	record.lastReported = snapshot(record.target);
	record.disarm = valtioSubscribe(record.target, () => {
		emitBareFlush(record.target);
	});
};

const disarmWatchdog = (record: EmitterRecord): void => {
	record.disarm?.();
	record.disarm = undefined;
};

export const deliver = (record: EmitterRecord, ops: ReadonlyArray<Op>, meta: unknown): void => {
	for (const listener of [...(record.groupListeners ?? [])]) listener(record.target, ops, meta);
	for (const listener of [...record.listeners]) listener(ops, meta);
};

export const requireObjectSnapshot = (value: unknown): object => {
	if (value !== null && (typeof value === "object" || typeof value === "function")) return value;

	throw new Error("opshot: state snapshots must have an object root");
};

export const settlePendingBare = (record: EmitterRecord): void => {
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

export function getOrCreateEmitter(target: object, groupListeners?: Set<GroupListener>): EmitterRecord {
	const resolved = resolveEmitterTarget(target);
	const existing = emitters.get(resolved);

	if (existing !== undefined) return existing;

	const record: EmitterRecord = {
		listeners: new Set(),
		groupListeners,
		lastReported: snapshot(resolved),
		isMutating: false,
		target: resolved,
	};

	emitters.set(resolved, record);

	return record;
}

export function mintGroupedEmitter(target: object, groupListeners: Set<GroupListener>): EmitterRecord {
	const record = getOrCreateEmitter(target, groupListeners);

	armWatchdog(record);

	return record;
}

export function emitBareFlush(target: object): void {
	const record = getEmitter(target);

	if (record === undefined) return;

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
}

export function addStateListener(state: object, listener: StateListener): () => void {
	const target = resolveEmitterTarget(state);
	let record = emitters.get(target);

	if (record === undefined) {
		record = getOrCreateEmitter(target);
		armWatchdog(record);
	} else if (record.disarm === undefined && record.groupListeners === undefined) {
		armWatchdog(record);
	}

	record.listeners.add(listener);

	return () => {
		if (!record.listeners.delete(listener)) return;

		if (record.groupListeners === undefined && record.listeners.size === 0) {
			disarmWatchdog(record);
			emitters.delete(target);
		}
	};
}

export function addGroupListener(groupListeners: Set<GroupListener>, listener: GroupListener): () => void {
	groupListeners.add(listener);

	return () => {
		groupListeners.delete(listener);
	};
}
