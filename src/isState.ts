import { unstable_getInternalStates } from "valtio/vanilla";
import { peelReadProxy } from "./peelReadProxy";

const { proxyStateMap } = unstable_getInternalStates();

/**
 * Returns whether a value is an opshot state.
 *
 * @param value - Value to test.
 * @returns True if it is a state.
 */
export function isState(value: unknown): value is object {
	const resolved = peelReadProxy(value);

	if (typeof resolved !== "object" || resolved === null) return false;

	return proxyStateMap.has(resolved);
}
