import { snapshot, unstable_getInternalStates } from "valtio/vanilla";
import { getSettings, type EmitOn } from "../settings";
import { resolveEmitterTarget } from "./resolveEmitterTarget";
import type { Op } from "../ops/operation";

/**
 * Listener for one state's changes.
 *
 * @param ops - Ops for the change.
 * @param meta - Writer meta, if any.
 * @returns Nothing.
 */
export type StateListener = (ops: ReadonlyArray<Op>, meta: unknown) => void;

/**
 * Listener for a group's changes.
 *
 * @param state - State that changed.
 * @param ops - Ops for the change.
 * @param meta - Writer meta, if any.
 * @returns Nothing.
 */
export type GroupListener = (state: object, ops: ReadonlyArray<Op>, meta: unknown) => void;

type StateListeners = Map<Function, Map<object | undefined, StateListener>>;

export type GroupListeners = Map<Function, Map<object | undefined, GroupListener>>;

export interface EmitterRecord {
	listeners: StateListeners;
	groupChain?: ReadonlyArray<GroupListeners>;
	lastReported: object;
	disarm?: () => void;
	isMutating: boolean;
	readonly target: object;
	emitOn?: EmitOn;
	pending: boolean;
	hasUnreported: boolean;
	claimedBy: object | undefined;
}

const emitters = new WeakMap<object, EmitterRecord>();

const { proxyStateMap } = unstable_getInternalStates();

export function getEmitter(state: object): EmitterRecord | undefined {
	return emitters.get(resolveEmitterTarget(state));
}

export const hasListeners = (record: EmitterRecord): boolean =>
	record.listeners.size > 0 || (record.groupChain?.some((map) => map.size > 0) ?? false);

export function getOrCreateEmitter(target: object, groupChain?: ReadonlyArray<GroupListeners>): EmitterRecord {
	const resolved = resolveEmitterTarget(target);
	const existing = emitters.get(resolved);

	if (existing !== undefined) return existing;

	const rawTarget = proxyStateMap.get(resolved)?.[0] ?? resolved;
	const emitOn = getSettings(rawTarget)?.emitOn;

	const record: EmitterRecord = {
		listeners: new Map(),
		groupChain,
		lastReported: snapshot(resolved),
		isMutating: false,
		target: resolved,
		emitOn,
		pending: false,
		hasUnreported: false,
		claimedBy: undefined,
	};

	emitters.set(resolved, record);

	return record;
}

export function deleteEmitter(target: object): void {
	emitters.delete(target);
}
