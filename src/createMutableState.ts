import { proxy } from "valtio/vanilla";
import { getGroupChain, type Group } from "./createGroup";
import { mintGroupedEmitter } from "./emit/emitterBare";
import { stampOptions, type MutableNodeOptions } from "./settings";
import { isUnsafeTracked, unsafeTrack } from "./unsafeTrack";
import { assertSafeDataPaths, installBoundary } from "./valtio/boundary";
import { frozenRootError, rejectionError } from "./valtio/boundaryErrors";
import { admissionDecision } from "./valtio/classify";

/**
 * Options for `createMutableState`, including optional group membership.
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

	if (decision.lane === "reject") {
		if (options?.strict !== false) throw rejectionError(properties, decision.kind);
	} else if (decision.lane !== "track") throw frozenRootError(properties);

	if (options?.strict !== false) assertSafeDataPaths(properties, [], new Set());

	const base = Object.create(Reflect.getPrototypeOf(properties)) as T;

	Object.defineProperties(base, Object.getOwnPropertyDescriptors(properties));

	if (decision.lane === "reject" || isUnsafeTracked(properties)) unsafeTrack(base);

	stampOptions(base, options);

	const proxied = proxy(base);

	if (options?.group !== undefined) {
		mintGroupedEmitter(proxied, getGroupChain(options.group));
	}

	return proxied;
}
