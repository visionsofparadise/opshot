import { requireHandle, type Handle } from "../handle";
import type { StateDeliver } from "./emitterRegistry";

interface StateBinding {
	readonly handle: Handle;
	readonly listener: Function;
}

const bindings = new WeakMap<() => void, StateBinding>();

export function addStateListener(state: object, listener: Function, deliver: StateDeliver): () => void {
	const handle = requireHandle(state, "opshot: subscribe requires a state");

	handle.subscribers.set(listener, deliver);

	const unsubscribe = (): void => {
		const held = bindings.get(unsubscribe);

		if (held === undefined) return;

		held.handle.subscribers.delete(held.listener);
		bindings.delete(unsubscribe);
	};

	bindings.set(unsubscribe, { handle, listener });

	return unsubscribe;
}
