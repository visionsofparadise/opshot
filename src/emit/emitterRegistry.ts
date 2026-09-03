import type { Operation } from "../operation";

/**
 * Listener for one state's changes.
 *
 * @param ops - Ops for the change.
 * @param meta - Writer meta, if any.
 * @returns Nothing.
 */
export type StateListener = (operations: ReadonlyArray<Operation>) => void;

export type StateDeliver = StateListener;

export type StateListeners = Map<Function, StateDeliver>;
