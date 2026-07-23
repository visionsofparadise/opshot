import { unstable_getInternalStates } from "valtio/vanilla";

import { unwrapWrapper } from "./react/resolveWrapper";

const { proxyStateMap } = unstable_getInternalStates();

export function isState(value: unknown): value is object {
	const resolved = unwrapWrapper(value);

	if (typeof resolved !== "object" || resolved === null) return false;

	return proxyStateMap.has(resolved);
}
