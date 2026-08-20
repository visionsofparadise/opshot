import { unstable_getInternalStates } from "valtio/vanilla";
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

export type StateListeners = Map<Function, Map<object | undefined, StateDeliver>>;

export type GroupListeners = Map<Function, Map<object | undefined, GroupDeliver>>;

const { proxyStateMap } = unstable_getInternalStates();

export const targetOf = (writeProxy: object): object => proxyStateMap.get(writeProxy)?.[0] ?? writeProxy;
