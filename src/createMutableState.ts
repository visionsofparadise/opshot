import { proxy, snapshot } from "valtio/vanilla";
import { getGroupChain, type Group } from "./createGroup";
import { armWatch } from "./emit/emitter";
import { requireObjectSnapshot } from "./emit/requireObjectSnapshot";
import { registerHandle, type Handle } from "./handle";
import { pendingIgnore } from "./ignore";
import { seedOccupancies } from "./occupancy";
import { pendingUnsafe } from "./unsafeTrack";
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

	readonly onError?: (error: unknown) => void;
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

	if (Object.isFrozen(properties) || pendingIgnore.has(properties)) return properties;

	const decision = admissionDecision(properties);
	const strict = options?.strict !== false;

	if (decision.lane === "leaf") return properties;

	if (decision.lane === "dangerous" && strict && !pendingUnsafe.has(properties)) {
		throw rejectionError(properties, decision.kind);
	}

	assertSafeDataPaths(properties, [], new Set(), strict ? "admission" : "rootsOnly");

	const base = Object.create(Reflect.getPrototypeOf(properties)) as T;

	Object.defineProperties(base, Object.getOwnPropertyDescriptors(properties));

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
		onError: options?.onError,
		unsafeAt: new Map(),
		ignoredAt: new Map(),
		members: new WeakSet(),
		routes: new WeakMap(),
		stamp: {},
		version: 0,
		replaying: false,
	};

	if (pendingUnsafe.has(properties)) {
		handle.unsafeAt.set("/", base);
		pendingUnsafe.delete(properties);
		pendingUnsafe.add(base);
	} else if (decision.lane === "dangerous") {
		pendingUnsafe.add(base);
	}

	registerHandle(base, handle);

	const instrumented = proxy({ root: base });

	handle.proxy = instrumented;
	handle.lastSnapshot = requireObjectSnapshot(snapshot(instrumented.root));
	seedOccupancies(handle);
	armWatch(handle);

	return instrumented.root;
}
