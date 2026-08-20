import { requireHandle, type Handle } from "../handle";
import type { GroupDeliver, GroupListeners, StateDeliver } from "./emitterRegistry";

interface StateBinding {
	readonly handle: Handle;
	readonly listener: Function;
	readonly channelId: object | undefined;
}

interface GroupBinding {
	readonly listeners: GroupListeners;
	readonly listener: Function;
	readonly channelId: object | undefined;
}

const bindings = new WeakMap<() => void, StateBinding | GroupBinding>();

const dropListenerChannel = <Deliver>(
	byListener: Map<Function, Map<object | undefined, Deliver>>,
	listener: Function,
	channelId: object | undefined,
	unsubscribe: () => void,
): void => {
	const channels = byListener.get(listener);

	if (channels?.has(channelId) !== true) {
		bindings.delete(unsubscribe);

		return;
	}

	channels.delete(channelId);

	if (channels.size === 0) byListener.delete(listener);

	bindings.delete(unsubscribe);
};

export const holdsBinding = (unsubscribe: () => void): boolean => bindings.has(unsubscribe);

export function addStateListener(
	state: object,
	listener: Function,
	channelId: object | undefined,
	deliver: StateDeliver,
): () => void {
	const handle = requireHandle(state, "opshot: subscribe requires a state");

	let byChannel = handle.subscribers.get(listener);

	if (byChannel === undefined) {
		byChannel = new Map();
		handle.subscribers.set(listener, byChannel);
	}

	byChannel.set(channelId, deliver);

	const unsubscribe = (): void => {
		const held = bindings.get(unsubscribe) as StateBinding | undefined;

		if (held === undefined) return;

		dropListenerChannel(held.handle.subscribers, held.listener, held.channelId, unsubscribe);
	};

	bindings.set(unsubscribe, { handle, listener, channelId });

	return unsubscribe;
}

export function addGroupListener(
	groupListeners: GroupListeners,
	listener: Function,
	channelId: object | undefined,
	deliver: GroupDeliver,
): () => void {
	let byChannel = groupListeners.get(listener);

	if (byChannel === undefined) {
		byChannel = new Map();
		groupListeners.set(listener, byChannel);
	}

	byChannel.set(channelId, deliver);

	const unsubscribe = (): void => {
		const held = bindings.get(unsubscribe) as GroupBinding | undefined;

		if (held === undefined) return;

		dropListenerChannel(held.listeners, held.listener, held.channelId, unsubscribe);
	};

	bindings.set(unsubscribe, { listeners: groupListeners, listener, channelId });

	return unsubscribe;
}
