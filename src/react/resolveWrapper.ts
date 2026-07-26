import { unstable_getInternalStates } from "valtio/vanilla";
import { getRegisteredWrapperTarget } from "./wrapperRegistry";

const { proxyStateMap } = unstable_getInternalStates();

const isObjectLike = (value: unknown): value is object =>
	value !== null && (typeof value === "object" || typeof value === "function");

export function unwrapWrapper(value: unknown): unknown {
	if (!isObjectLike(value) || proxyStateMap.has(value)) return value;

	let current: unknown = value;

	while (isObjectLike(current)) {
		const registeredTarget = getRegisteredWrapperTarget(current);

		if (registeredTarget === undefined) break;

		current = registeredTarget;
	}

	return current;
}
