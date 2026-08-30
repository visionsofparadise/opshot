import { unstable_getInternalStates } from "valtio/vanilla";
import { peelReadProxy } from "../peelReadProxy";

const { proxyStateMap } = unstable_getInternalStates();

/**
 * Resolves a valtio proxy to the raw target it wraps, passing any other value through.
 *
 * @param value - Proxy or raw value.
 * @returns The raw target.
 */
export const rawTargetOf = (value: object): object => proxyStateMap.get(value)?.[0] ?? value;

/**
 * Peels a read proxy and then resolves the result to its raw target, the identity nodes are keyed by.
 *
 * @param node - Node in any wrapping.
 * @returns The raw target.
 */
export const rawOf = (node: object): object => {
	const peeled = peelReadProxy(node);

	return rawTargetOf(typeof peeled === "object" && peeled !== null ? peeled : node);
};
