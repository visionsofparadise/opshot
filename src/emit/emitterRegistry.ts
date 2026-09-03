import type { Operation } from "../operation";

/**
 * Listener for one state's changes.
 *
 * @param operations - Operations for the change.
 */
export type StateListener = (operations: ReadonlyArray<Operation>) => void;

export type StateDeliver = StateListener;

export type StateListeners = Map<Function, StateDeliver>;
