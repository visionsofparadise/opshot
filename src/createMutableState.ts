import { proxy, snapshot } from "valtio/vanilla";
import { getGroupChain, type Group } from "./createGroup";
import { seedInEdges } from "./edges";
import { armWatch } from "./emit/emitter";
import { requireObjectSnapshot } from "./emit/requireObjectSnapshot";
import { registerHandle, type Handle } from "./handle";
import { isIgnored } from "./ignore";
import { isState } from "./isState";
import { seedOccupancies } from "./occupancy";
import { peelReadProxy } from "./peelReadProxy";
import { isUnsafeMarked } from "./unsafeTrack";
import { assertSafeDataPaths, installBoundary } from "./valtio/boundary";
import { rejectionError } from "./valtio/boundaryErrors";
import { admissionDecision } from "./valtio/classify";
import type { MutableNodeOptions } from "./settings";

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
 * `ignore()` marks an object so every edge to it is untracked. `unsafeTrack()` marks an object so a node entering while marked, or entering beneath an exempt node, is exempt from strict.
 *
 * @typeParam T - State shape.
 * @param properties - Initial fields.
 * @param options - Creation options.
 * @returns The state.
 */
export function createMutableState<T extends object>(properties: T, options?: MutableStateOptions): T {
	installBoundary();

	const root: unknown = properties;

	if (typeof root !== "object" || root === null) return root as T;

	if (isIgnored(root)) return root as T;

	if (Object.isFrozen(root)) return root as T;

	if (isState(root)) {
		const peeled = peelReadProxy(root);

		if (typeof peeled === "object" && peeled !== null) return peeled as T;
	}

	const decision = admissionDecision(root);
	const strict = options?.strict !== false;

	if (decision.lane === "leaf") return root as T;

	const base = Object.create(Reflect.getPrototypeOf(root)) as object;

	Object.defineProperties(base, Object.getOwnPropertyDescriptors(root));

	const exempt = isUnsafeMarked(root);

	if (decision.lane === "dangerous" && strict && !exempt) {
		throw rejectionError(base, decision.kind);
	}

	assertSafeDataPaths(base, [], new Set(), strict ? "admission" : "rootsOnly", exempt);

	const handle: Handle = {
		proxy: { root: base },
		lastSnapshot: base,
		hasPendingWrites: false,
		isFlushScheduled: false,
		isFlushHeld: false,
		flushGeneration: 0,
		subscribers: new Map(),
		groups: options?.group !== undefined ? getGroupChain(options.group) : undefined,
		emitOn: options?.emitOn,
		strict,
		nodes: new WeakMap(),
		byId: new Map(),
		nextInternId: 1,
		stamp: {},
		version: 0,
		replaying: false,
		pendingOwner: undefined,
	};

	registerHandle(base, handle);
	handle.nodes.set(base, { edges: [], id: 0, exempt });
	handle.byId.set(0, base);

	const instrumented = proxy({ root: base });

	handle.proxy = instrumented;
	handle.lastSnapshot = requireObjectSnapshot(snapshot(instrumented.root));
	seedInEdges(handle);
	seedOccupancies(handle);
	armWatch(handle);

	return instrumented.root as T;
}
