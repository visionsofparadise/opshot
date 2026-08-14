import { unstable_getInternalStates } from "valtio/vanilla";

const handles = new WeakMap<object, object>();

const { proxyStateMap } = unstable_getInternalStates();

export const registerHandle = (rootTarget: object, handle: object): void => {
	handles.set(rootTarget, handle);
};

export const handleOf = (node: object): object | undefined => {
	const target = proxyStateMap.get(node)?.[0] ?? node;

	return handles.get(target);
};
