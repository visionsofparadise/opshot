import { proxy, snapshot } from "valtio/vanilla";
import { getGroupChain, type Group } from "./createGroup";
import { armWatch } from "./emit/emitterBare";
import { registerHandle, type Handle } from "./handle";
import { getOptions, stampOptions, type MutableNodeOptions } from "./settings";
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

	if (decision.lane === "leaf" || decision.lane === "untracked") return properties;

	if (decision.lane === "dangerous") {
		if (options?.strict !== false) throw rejectionError(properties, decision.kind);
	}

	assertSafeDataPaths(properties, [], new Set(), options?.strict !== false ? "admission" : "rootsOnly");

	const base = Object.create(Reflect.getPrototypeOf(properties)) as T;

	Object.defineProperties(base, Object.getOwnPropertyDescriptors(properties));

	if (decision.lane === "dangerous" || isUnsafeTracked(properties)) unsafeTrack(base);

	stampOptions(base, options);

	const receiverOptions = getOptions(base);

	assertInitializerStrictnessJoins(properties, receiverOptions?.strict !== false);

	const instrumented = proxy({ root: base });
	const lastSnapshot: unknown = snapshot(instrumented.root);

	if (lastSnapshot === null || (typeof lastSnapshot !== "object" && typeof lastSnapshot !== "function")) {
		throw new Error("opshot: state snapshots must have an object root");
	}

	const handle: Handle = {
		proxy: instrumented,
		lastSnapshot,
		hasPendingWrites: false,
		isFlushScheduled: false,
		isFlushHeld: false,
		flushGeneration: 0,
		subscribers: new Map(),
		groups: options?.group !== undefined ? getGroupChain(options.group) : undefined,
	};

	registerHandle(base, handle);
	armWatch(handle);

	return instrumented.root;
}
