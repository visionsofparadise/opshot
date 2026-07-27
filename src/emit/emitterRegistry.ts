import { snapshot } from "valtio/vanilla";
import { resolveEmitterTarget } from "./resolveEmitterTarget";
import type { Op } from "../ops/operation";

export type StateListener = (ops: ReadonlyArray<Op>, meta: unknown) => void;
export type GroupListener = (state: object, ops: ReadonlyArray<Op>, meta: unknown) => void;

type StateListeners = Map<Function, Map<object | undefined, StateListener>>;

export type GroupListeners = Map<Function, Map<object | undefined, GroupListener>>;

export interface EmitterRecord {
	listeners: StateListeners;
	groupListeners?: GroupListeners;
	lastReported: object;
	disarm?: () => void;
	isMutating: boolean;
	readonly target: object;
}

const emitters = new WeakMap<object, EmitterRecord>();

export function getEmitter(state: object): EmitterRecord | undefined {
	return emitters.get(resolveEmitterTarget(state));
}

export const hasListeners = (record: EmitterRecord): boolean =>
	record.listeners.size > 0 || (record.groupListeners?.size ?? 0) > 0;

export function getOrCreateEmitter(target: object, groupListeners?: GroupListeners): EmitterRecord {
	const resolved = resolveEmitterTarget(target);
	const existing = emitters.get(resolved);

	if (existing !== undefined) return existing;

	const record: EmitterRecord = {
		listeners: new Map(),
		groupListeners,
		lastReported: snapshot(resolved),
		isMutating: false,
		target: resolved,
	};

	emitters.set(resolved, record);

	return record;
}

export function deleteEmitter(target: object): void {
	emitters.delete(target);
}
