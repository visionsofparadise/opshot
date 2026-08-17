import { getGroupListeners, isGroup, type Group } from "./createGroup";
import { addGroupListener, addStateListener } from "./emit/emitterListeners";
import type { GroupListener, StateListener } from "./emit/emitterRegistry";

/**
 * Listener context from a channel subscription.
 *
 * @typeParam M - Meta type for this channel.
 */
export type Context<M> =
	{ readonly isTransaction: true; readonly meta: M } | { readonly isTransaction: false; readonly meta: unknown };

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
 * @param state - State (or nested object) to listen to.
 * @param listener - Called on each change.
 * @returns Unsubscribe function.
 */
export function subscribe(state: object, listener: StateListener): () => void;
export function subscribe(target: object | Group, listener: StateListener | GroupListener): () => void {
	if (isGroup(target)) {
		return addGroupListener(getGroupListeners(target), listener, undefined, (state, ops, meta) => {
			(listener as GroupListener)(state, ops, unwrapTransportMeta(meta));
		});
	}

	return addStateListener(target, listener, undefined, (ops, meta) => {
		(listener as StateListener)(ops, unwrapTransportMeta(meta));
	});
}

const channelStampBrand: unique symbol = Symbol.for("opshot.channelStamp");

export interface ChannelStamp {
	readonly [channelStampBrand]: object;
	readonly meta: object | undefined;
}

export function stampChannelMeta(channelId: object, meta?: object): ChannelStamp {
	return { [channelStampBrand]: channelId, meta };
}

function isChannelStamp(value: unknown): value is ChannelStamp {
	return typeof value === "object" && value !== null && channelStampBrand in value;
}

function isOwnChannelStamp(value: unknown, channelId: object): value is ChannelStamp {
	return isChannelStamp(value) && value[channelStampBrand] === channelId;
}

function unwrapTransportMeta(meta: unknown): unknown {
	if (isChannelStamp(meta)) return meta.meta;

	return meta;
}

export function toChannelContext<M extends object>(
	channelId: object,
	defaults: M | undefined,
	meta: unknown,
): Context<M> {
	if (isOwnChannelStamp(meta, channelId)) {
		return { isTransaction: true, meta: { ...defaults, ...meta.meta } as M };
	}

	return { isTransaction: false, meta: unwrapTransportMeta(meta) };
}
