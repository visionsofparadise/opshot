import { unstable_getInternalStates } from "valtio/vanilla";
import { peelIdentityLayer } from "../identity";

const { proxyStateMap } = unstable_getInternalStates();

const isObjectLike = (value: unknown): value is object =>
	value !== null && (typeof value === "object" || typeof value === "function");

export function resolveWriteProxy(state: object): object {
	let current: unknown = state;

	while (isObjectLike(current)) {
		if (proxyStateMap.has(current)) return current;

		const peeled = peelIdentityLayer(current);

		if (peeled === undefined) break;

		current = peeled;
	}

	if (!isObjectLike(current) || !proxyStateMap.has(current)) throw new Error("opshot: expected a state object");

	return current;
}
