import { proxy } from "valtio/vanilla";
import { getGroupChain, type Group } from "./createGroup";
import { mintGroupedEmitter } from "./emit/emitterBare";
import { stampSettings, type StateSettings } from "./settings";
import { assertSafeDataPaths, installBoundary } from "./valtio/boundary";

/**
 * Options for `createMutableState`.
 *
 * @example
 * createMutableState({ count: 0 }, { group, emitOn, strict: false })
 */
export interface MutableStateOptions extends StateSettings {
	/**
	 * Group that receives this state's changes.
	 */
	readonly group?: Group;
}

/**
 * Creates a mutable state object.
 *
 * @typeParam T - State shape.
 * @param properties - Initial fields.
 * @param options - Creation options.
 * @returns The state.
 */
export function createMutableState<T extends object>(properties: T, options?: MutableStateOptions): T {
	installBoundary();

	assertSafeDataPaths(properties, [], new Map(), options?.strict !== false);

	const base = Object.create(Reflect.getPrototypeOf(properties)) as T;

	Object.defineProperties(base, Object.getOwnPropertyDescriptors(properties));

	stampSettings(base, options);

	const proxied = proxy(base);

	if (options?.group !== undefined) {
		mintGroupedEmitter(proxied, getGroupChain(options.group));
	}

	return proxied;
}
