import { snapshot } from "valtio/vanilla";
import { requireHandle, type Handle } from "../handle";
import { emitWrites } from "./emitterBare";
import { hasListeners, type GroupDeliver, type GroupListeners, type StateDeliver } from "./emitterRegistry";

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

export const holdsBinding = (unsubscribe: () => void): boolean => bindings.has(unsubscribe);

export function addStateListener(
	state: object,
	listener: Function,
	channelId: object | undefined,
	deliver: StateDeliver,
): () => void {
	const handle = requireHandle(state, "opshot: subscribe requires a state");

	if (!hasListeners(handle)) {
		handle.lastSnapshot = snapshot(handle.proxy.root);
	}

	let byChannel = handle.subscribers.get(listener);

	if (byChannel === undefined) {
		byChannel = new Map();
		handle.subscribers.set(listener, byChannel);
	}

	byChannel.set(channelId, deliver);

	const unsubscribe = (): void => {
		const held = bindings.get(unsubscribe) as StateBinding | undefined;

		if (held === undefined) return;

		const channels = held.handle.subscribers.get(held.listener);

		if (channels?.has(held.channelId) !== true) {
			bindings.delete(unsubscribe);

			return;
		}

		emitWrites(held.handle);
		channels.delete(held.channelId);

		if (channels.size === 0) held.handle.subscribers.delete(held.listener);

		bindings.delete(unsubscribe);
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

		const channels = held.listeners.get(held.listener);

		if (channels?.has(held.channelId) !== true) {
			bindings.delete(unsubscribe);

			return;
		}

		channels.delete(held.channelId);

		if (channels.size === 0) held.listeners.delete(held.listener);

		bindings.delete(unsubscribe);
	};

	bindings.set(unsubscribe, { listeners: groupListeners, listener, channelId });

	return unsubscribe;
}
