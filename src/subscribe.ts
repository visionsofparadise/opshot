import { addStateListener } from "./emit/emitterListeners";
import type { StateListener } from "./emit/emitterRegistry";

/**
 * Listens for changes to a state.
 *
 * @param state - State to listen to.
 * @param listener - Called on each change.
 * @returns Unsubscribe function.
 */
export function subscribe(state: object, listener: StateListener): () => void {
	return addStateListener(state, listener, listener);
}
