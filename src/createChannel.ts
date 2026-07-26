import { getGroupListeners, isGroup, type Group } from "./createGroup";
import { addGroupListener, addStateListener } from "./emitter";
import { applyOps as standaloneApplyOps } from "./ops/applyOps";
import { stampChannelMeta, toChannelContext, type Context, type Op } from "./subscribe";
import { transact as standaloneTransact } from "./transact";
import type { Operation } from "./ops/operation";

export interface Channel<M extends object> {
	transact(state: object, mutate: () => void, meta?: Partial<M>): void;

	subscribe(group: Group, listener: (state: object, ops: ReadonlyArray<Op>, context: Context<M>) => void): () => void;

	subscribe(state: object, listener: (ops: ReadonlyArray<Op>, context: Context<M>) => void): () => void;

	applyOps(state: object, operations: ReadonlyArray<Operation>, meta?: Partial<M>): void;
}

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
			return addGroupListener(getGroupListeners(target), (state, ops, meta) => {
				(listener as (state: object, ops: ReadonlyArray<Op>, context: Context<M>) => void)(
					state,
					ops,
					toChannelContext(channelId, defaults, meta),
				);
			});
		}

		return addStateListener(target, (ops, meta) => {
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
