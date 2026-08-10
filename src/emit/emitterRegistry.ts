import { snapshot, unstable_getInternalStates } from "valtio/vanilla";
import { resolveWriteProxy } from "./resolveWriteProxy";
import type { Operation } from "../ops/operation";

/**
 * Listener for one state's changes.
 *
 * @param ops - Ops for the change.
 * @param meta - Writer meta, if any.
 * @returns Nothing.
 */
export type StateListener = (ops: ReadonlyArray<Operation>, meta: unknown) => void;

/**
 * Listener for a group's changes.
 *
 * @param state - State that changed.
 * @param ops - Ops for the change.
 * @param meta - Writer meta, if any.
 * @returns Nothing.
 */
export type GroupListener = (state: object, ops: ReadonlyArray<Operation>, meta: unknown) => void;

export type StateDeliver = (ops: ReadonlyArray<Operation>, meta: unknown, channelId: object | undefined) => void;

export type GroupDeliver = (
	state: object,
	ops: ReadonlyArray<Operation>,
	meta: unknown,
	channelId: object | undefined,
) => void;

type StateListeners = Map<Function, Map<object | undefined, StateDeliver>>;

export type GroupListeners = Map<Function, Map<object | undefined, GroupDeliver>>;

export interface EmitterRecord {
	listeners: StateListeners;
	groupChain?: ReadonlyArray<GroupListeners>;
	lastReported: object;
	disarmEmission?: () => void;
	readonly writeProxy: object;
	pending: boolean;
	hasUnreported: boolean;
	claimed: boolean;
}

const emitters = new WeakMap<object, EmitterRecord>();

const { proxyStateMap } = unstable_getInternalStates();

export const targetOf = (writeProxy: object): object => proxyStateMap.get(writeProxy)?.[0] ?? writeProxy;

export function getEmitter(state: object): EmitterRecord | undefined {
	return emitters.get(resolveWriteProxy(state));
}

export const hasListeners = (record: EmitterRecord): boolean =>
	record.listeners.size > 0 || (record.groupChain?.some((map) => map.size > 0) ?? false);

export function getOrCreateEmitter(writeProxy: object, groupChain?: ReadonlyArray<GroupListeners>): EmitterRecord {
	const existing = emitters.get(writeProxy);

	if (existing !== undefined) return existing;

	const record: EmitterRecord = {
		listeners: new Map(),
		groupChain,
		lastReported: snapshot(writeProxy),
		writeProxy,
		pending: false,
		hasUnreported: false,
		claimed: false,
	};

	emitters.set(writeProxy, record);

	return record;
}

export function deleteEmitter(writeProxy: object): void {
	emitters.delete(writeProxy);
}
