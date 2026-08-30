import { requireHandle, type Handle } from "../handle";
import type { GroupDeliver, GroupListeners, StateDeliver } from "./emitterRegistry";

interface StateBinding {
	readonly handle: Handle;
	readonly listener: Function;
}

interface GroupBinding {
	readonly listeners: GroupListeners;
	readonly listener: Function;
}

const bindings = new WeakMap<() => void, StateBinding | GroupBinding>();

export function addStateListener(state: object, listener: Function, deliver: StateDeliver): () => void {
	const handle = requireHandle(state, "opshot: subscribe requires a state");

	handle.subscribers.set(listener, deliver);

	const unsubscribe = (): void => {
		const held = bindings.get(unsubscribe) as StateBinding | undefined;

		if (held === undefined) return;

		held.handle.subscribers.delete(held.listener);
		bindings.delete(unsubscribe);
	};

	bindings.set(unsubscribe, { handle, listener });

	return unsubscribe;
}

export function addGroupListener(listeners: GroupListeners, listener: Function, deliver: GroupDeliver): () => void {
	listeners.set(listener, deliver);

	const unsubscribe = (): void => {
		const held = bindings.get(unsubscribe) as GroupBinding | undefined;

		if (held === undefined) return;

		held.listeners.delete(held.listener);
		bindings.delete(unsubscribe);
	};

	bindings.set(unsubscribe, { listeners, listener });

	return unsubscribe;
}
