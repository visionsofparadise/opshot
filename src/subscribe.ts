import { getGroupListeners, isGroup, type Group } from "./createGroup";
import { addGroupListener, addStateListener, type GroupListener, type StateListener } from "./emitter";

export type { GroupListener, StateListener } from "./emitter";
export type { Op } from "./ops/operation";

export type Context<M> =
	{ readonly isTransaction: true; readonly meta: M } | { readonly isTransaction: false; readonly meta: unknown };

export function subscribe(group: Group, listener: GroupListener): () => void;
export function subscribe(state: object, listener: StateListener): () => void;
export function subscribe(target: object | Group, listener: StateListener | GroupListener): () => void {
	if (isGroup(target)) return addGroupListener(getGroupListeners(target), listener as GroupListener);

	return addStateListener(target, (ops, meta) => {
		(listener as StateListener)(ops, unwrapTransportMeta(meta));
	});
}

const channelStampBrand: unique symbol = Symbol("opshot.channelStamp");

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
