import { getGroupListeners, isGroup, type Group } from "./createGroup";
import { addGroupListener, addStateListener } from "./emit/emitterListeners";
import { applyOperations as standaloneApplyOperations } from "./ops/applyOperations";
import { stampChannelMeta, toChannelContext, type EmissionContext } from "./subscribe";
import { transact as standaloneTransact } from "./transact";
import type { ApplyDirection } from "./ops/applyMutations";
import type { Operation } from "./ops/operation";

/**
 * Channel-bound `transact`, `subscribe`, and `applyOperations`.
 *
 * @typeParam M - Meta type for this channel.
 */
export interface Channel<M extends object> {
	/**
	 * Runs a transaction with this channel's meta.
	 *
	 * @param state - State to change.
	 * @param mutate - Function that writes the state.
	 * @param meta - Meta for this write.
	 * @returns Nothing.
	 */
	transact(state: object, mutate: () => void, meta?: Partial<M>): void;

	/**
	 * Listens for changes from a group's states, including nested groups.
	 * Outer groups run first.
	 *
	 * @param group - Group to listen to.
	 * @param listener - Called on each change.
	 * @returns Unsubscribe function.
	 */
	subscribe(
		group: Group,
		listener: (state: object, ops: ReadonlyArray<Operation>, context: EmissionContext<M>) => void,
	): () => void;

	/**
	 * Listens for changes to a state.
	 *
	 * @param state - State (or nested object) to listen to.
	 * @param listener - Called on each change.
	 * @returns Unsubscribe function.
	 */
	subscribe(state: object, listener: (ops: ReadonlyArray<Operation>, context: EmissionContext<M>) => void): () => void;

	/**
	 * Applies operation pairs with this channel's meta.
	 *
	 * @param state - State to change.
	 * @param operations - Operation pairs to apply.
	 * @param direction - Which half to apply, and the ordering that direction implies.
	 * @param meta - Meta for this write.
	 * @returns Nothing.
	 */
	applyOperations(
		state: object,
		operations: ReadonlyArray<Operation>,
		direction: ApplyDirection,
		meta?: Partial<M>,
	): void;
}

/**
 * Creates a channel with a typed meta convention.
 *
 * @typeParam M - Meta type for this channel.
 * @param defaults - Default meta for this channel's writes.
 * @returns The channel.
 */
export function createChannel<M extends object>(defaults?: M): Channel<M> {
	const channelId = Object.freeze({});

	function transact(state: object, mutate: () => void, meta?: Partial<M>): void {
		standaloneTransact(state, mutate, stampChannelMeta(channelId, meta));
	}

	function subscribe(
		group: Group,
		listener: (state: object, ops: ReadonlyArray<Operation>, context: EmissionContext<M>) => void,
	): () => void;

	function subscribe(
		state: object,
		listener: (ops: ReadonlyArray<Operation>, context: EmissionContext<M>) => void,
	): () => void;

	function subscribe(
		target: object | Group,
		listener:
			| ((ops: ReadonlyArray<Operation>, context: EmissionContext<M>) => void)
			| ((state: object, ops: ReadonlyArray<Operation>, context: EmissionContext<M>) => void),
	): () => void {
		if (isGroup(target)) {
			return addGroupListener(getGroupListeners(target), listener, channelId, (state, ops, meta) => {
				(listener as (state: object, ops: ReadonlyArray<Operation>, context: EmissionContext<M>) => void)(
					state,
					ops,
					toChannelContext(channelId, defaults, meta),
				);
			});
		}

		return addStateListener(target, listener, channelId, (ops, meta) => {
			(listener as (ops: ReadonlyArray<Operation>, context: EmissionContext<M>) => void)(
				ops,
				toChannelContext(channelId, defaults, meta),
			);
		});
	}

	function applyOperations(
		state: object,
		operations: ReadonlyArray<Operation>,
		direction: ApplyDirection,
		meta?: Partial<M>,
	): void {
		standaloneApplyOperations(state, operations, direction, stampChannelMeta(channelId, meta));
	}

	return { transact, subscribe, applyOperations };
}
