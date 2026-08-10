import { getGroupListeners, isGroup, type Group } from "./createGroup";
import { addGroupListener, addStateListener } from "./emit/emitterListeners";
import type { GroupDeliver, GroupListener, StateDeliver, StateListener } from "./emit/emitterRegistry";

/**
 * Listener context from a channel subscription.
 *
 * @typeParam M - Meta type for this channel.
 */
export type EmissionContext<M> =
	{ readonly isTransaction: true; readonly meta: M } | { readonly isTransaction: false; readonly meta: unknown };

/**
 * Listens for changes from a group's states, including nested groups.
 * Outer groups run first.
 *
 * Hears every `transact` on one of those states, at any depth, with its meta.
 *
 * @param group - Group to listen to.
 * @param listener - Called on each change.
 * @returns Unsubscribe function.
 */
export function subscribe(group: Group, listener: GroupListener): () => void;

/**
 * Listens for changes to a state.
 *
 * Hears every write beneath this node, as paths relative to it. A `transact`
 * at, above, or below this node delivers synchronously and carries its meta;
 * a bare write delivers on the state's emission window with no meta.
 *
 * @param state - State (or nested object) to listen to.
 * @param listener - Called on each change.
 * @returns Unsubscribe function.
 */
export function subscribe(state: object, listener: StateListener): () => void;
export function subscribe(target: object | Group, listener: StateListener | GroupListener): () => void {
	if (isGroup(target)) {
		return addGroupListener(getGroupListeners(target), listener, undefined, listener as GroupDeliver);
	}

	return addStateListener(target, listener, undefined, listener as StateDeliver);
}

export function toChannelContext<M extends object>(
	channelId: object,
	defaults: M | undefined,
	meta: unknown,
	deliveredChannelId: object | undefined,
): EmissionContext<M> {
	if (deliveredChannelId === channelId) {
		return {
			isTransaction: true,
			meta: { ...defaults, ...(typeof meta === "object" && meta !== null ? meta : undefined) } as M,
		};
	}

	return { isTransaction: false, meta };
}
