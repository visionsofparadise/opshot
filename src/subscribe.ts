import { addStateListener } from "./emit/emitterListeners";
import type { StateListener } from "./emit/emitterRegistry";

/**
 * Listens for changes to a state.
 *
 * @typeParam M - Meta type the caller asserts for the state's batches.
 * @param state - State to listen to.
 * @param listener - Called on each change.
 * @returns Unsubscribe function.
 */
export function subscribe<M = unknown>(state: object, listener: StateListener<M>): () => void {
	return addStateListener(state, listener, listener as StateListener);
}
