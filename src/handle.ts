import { unstable_getInternalStates } from "valtio/vanilla";
import type { GroupListeners, StateListeners } from "./emit/emitterRegistry";

const handles = new WeakMap<object, Handle>();

const { proxyStateMap } = unstable_getInternalStates();

export interface Handle {
	readonly proxy: { readonly root: object };
	lastSnapshot: object;
	hasPendingWrites: boolean;
	isFlushScheduled: boolean;
	isFlushHeld: boolean;
	flushGeneration: number;
	subscribers: StateListeners;
	groups?: ReadonlyArray<GroupListeners>;
	disarmWatch?: () => void;
}

export const registerHandle = (rootTarget: object, handle: Handle): void => {
	handles.set(rootTarget, handle);
};

export const handleOf = (node: object): Handle | undefined => {
	const target = proxyStateMap.get(node)?.[0] ?? node;

	return handles.get(target);
};

export function requireHandle(state: object, message: string): Handle {
	const value: unknown = state;

	if (typeof value !== "object" || value === null) throw new Error(message);

	const handle = handleOf(value);

	if (handle === undefined) throw new Error(message);

	return handle;
}
