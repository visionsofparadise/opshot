import { proxy } from "valtio/vanilla";
import { getGroupChain, type Group } from "./createGroup";
import { mintGroupedEmitter } from "./emit/emitterBare";
import { getOptions, stampOptions, type MutableNodeOptions } from "./settings";
import { markStateRoot } from "./stateRoots";
import { isUnsafeTracked, unsafeTrack } from "./unsafeTrack";
import { assertInitializerStrictnessJoins, assertSafeDataPaths, installBoundary } from "./valtio/boundary";
import { rejectionError } from "./valtio/boundaryErrors";
import { admissionDecision } from "./valtio/classify";

/**
 * Options for `createMutableState`.
 *
 * @example
 * createMutableState({ count: 0 }, { group, emitOn, strict: false })
 */
export interface MutableStateOptions extends MutableNodeOptions {
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

	const decision = admissionDecision(properties);

	if (decision.lane === "leaf") return properties;

	if (decision.lane === "reject") {
		if (options?.strict !== false) throw rejectionError(properties, decision.kind);
	}

	assertSafeDataPaths(properties, [], new Set(), options?.strict !== false ? "admission" : "rootsOnly");

	const base = Object.create(Reflect.getPrototypeOf(properties)) as T;

	Object.defineProperties(base, Object.getOwnPropertyDescriptors(properties));

	if (decision.lane === "reject" || isUnsafeTracked(properties)) unsafeTrack(base);

	stampOptions(base, options);

	const receiverOptions = getOptions(base);

	assertInitializerStrictnessJoins(properties, receiverOptions?.strict !== false);
	markStateRoot(base);

	const proxied = proxy(base);

	if (options?.group !== undefined) {
		mintGroupedEmitter(proxied, getGroupChain(options.group));
	}

	return proxied;
}
