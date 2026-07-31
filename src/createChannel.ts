import { getGroupListeners, isGroup, type Group } from "./createGroup";
import { addGroupListener, addStateListener } from "./emit/emitterListeners";
import { applyOps as standaloneApplyOps } from "./ops/applyOps";
import { stampChannelMeta, toChannelContext, type Context } from "./subscribe";
import { transact as standaloneTransact } from "./transact";
import type { Op, Operation } from "./ops/operation";

/**
 * Channel-bound `transact`, `subscribe`, and `applyOps`.
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
	 * Listens for changes from a group's states.
	 *
	 * @param group - Group to listen to.
	 * @param listener - Called on each change.
	 * @returns Unsubscribe function.
	 */
	subscribe(group: Group, listener: (state: object, ops: ReadonlyArray<Op>, context: Context<M>) => void): () => void;

	/**
	 * Listens for changes to a state.
	 *
	 * @param state - State (or nested object) to listen to.
	 * @param listener - Called on each change.
	 * @returns Unsubscribe function.
	 */
	subscribe(state: object, listener: (ops: ReadonlyArray<Op>, context: Context<M>) => void): () => void;

	/**
	 * Applies operations with this channel's meta.
	 *
	 * @param state - State to change.
	 * @param operations - Operations to apply.
	 * @param meta - Meta for this write.
	 * @returns Nothing.
	 */
	applyOps(state: object, operations: ReadonlyArray<Operation>, meta?: Partial<M>): void;
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
		listener: (state: object, ops: ReadonlyArray<Op>, context: Context<M>) => void,
	): () => void;

	function subscribe(state: object, listener: (ops: ReadonlyArray<Op>, context: Context<M>) => void): () => void;

	function subscribe(
		target: object | Group,
		listener:
			| ((ops: ReadonlyArray<Op>, context: Context<M>) => void)
			| ((state: object, ops: ReadonlyArray<Op>, context: Context<M>) => void),
	): () => void {
		if (isGroup(target)) {
			return addGroupListener(getGroupListeners(target), listener, channelId, (state, ops, meta) => {
				(listener as (state: object, ops: ReadonlyArray<Op>, context: Context<M>) => void)(
					state,
					ops,
					toChannelContext(channelId, defaults, meta),
				);
			});
		}

		return addStateListener(target, listener, channelId, (ops, meta) => {
			(listener as (ops: ReadonlyArray<Op>, context: Context<M>) => void)(
				ops,
				toChannelContext(channelId, defaults, meta),
			);
		});
	}

	function applyOps(state: object, operations: ReadonlyArray<Operation>, meta?: Partial<M>): void {
		standaloneApplyOps(state, operations, stampChannelMeta(channelId, meta));
	}

	return { transact, subscribe, applyOps };
}
