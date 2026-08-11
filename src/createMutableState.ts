import { proxy } from "valtio/vanilla";
import { getGroupChain, type Group } from "./createGroup";
import { mintGroupedEmitter } from "./emit/emitterBare";
import { markStateRoot } from "./inEdges";
import { getOptions, stampOptions, type MutableNodeOptions } from "./settings";
import { isUnsafeTracked, unsafeTrack } from "./unsafeTrack";
import { assertInitializerStrictnessJoins, assertSafeDataPaths, installBoundary } from "./valtio/boundary";
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
 * A state is everything reachable from its root through tracked edges. Every tracked edge's target
 * has a determined treatment — tracked, by shape or `unsafeTrack()`, or endpoint, by `ignore()`,
 * freeze, or ride-along declaration — and an edge whose target has no determined treatment throws
 * at its formation. The graph ends at its endpoints; beyond them the model is silent. Graphs of
 * differing strictness refuse to join (match `strict`, clone into the receiver, or share as
 * `ignore()`). Each state's op stream is self-contained and closure-surfaced within its own graph;
 * identity across states is live-only, never carried. Cycles and aliases are ordinary tracked
 * topology: no cycle throws at formation or later.
 *
 * @typeParam T - State shape.
 * @param properties - Initial fields.
 * @param options - Creation options (`group`, `emitOn`, `strict`). Default `strict` is true; pass
 *   `strict: false` to unsafely track values that would otherwise be rejected.
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

	const receiverOptions = getOptions(base);

	assertInitializerStrictnessJoins(properties, receiverOptions?.strict !== false, receiverOptions);
	markStateRoot(base);

	const proxied = proxy(base);

	if (options?.group !== undefined) {
		mintGroupedEmitter(proxied, getGroupChain(options.group));
	}

	return proxied;
}
