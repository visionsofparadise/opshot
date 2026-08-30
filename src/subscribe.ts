import { getGroupListeners, isGroup, type Group } from "./createGroup";
import { addGroupListener, addStateListener } from "./emit/emitterListeners";
import type { GroupListener, StateListener } from "./emit/emitterRegistry";

/**
 * Listens for changes from a group's states.
 *
 * @param group - Group to listen to.
 * @param listener - Called on each change.
 * @returns Unsubscribe function.
 */
export function subscribe(group: Group, listener: GroupListener): () => void;

/**
 * Listens for changes to a state.
 *
 * @param state - State to listen to.
 * @param listener - Called on each change.
 * @returns Unsubscribe function.
 */
export function subscribe(state: object, listener: StateListener): () => void;
export function subscribe(target: object | Group, listener: StateListener | GroupListener): () => void {
	if (isGroup(target)) {
		return addGroupListener(getGroupListeners(target), listener, listener as GroupListener);
	}

	return addStateListener(target, listener, listener as StateListener);
}
