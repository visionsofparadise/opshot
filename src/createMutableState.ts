import { assertAdmissible } from "./admission";
import { attach, isTrackedEntry } from "./edges";
import { handleOf, type Handle } from "./handle";
import { isIgnored } from "./ignore";
import { installProxyHandler, proxyOf, recordOf, rawOf } from "./node";
import { handler } from "./proxy";
import { isUnsafeMarked } from "./unsafeTrack";
import { walkDataEntries } from "./utils/dataEntries";

installProxyHandler(handler);

/**
 * Schedules when bare writes notify listeners. Call `flush` once.
 *
 * @param flush - Delivers pending ops.
 * @returns Nothing.
 */
export type EmissionScheduler = (flush: () => void) => void;

/**
 * Options for `createMutableState`.
 *
 * @example
 * createMutableState({ count: 0 }, { group, emitOn, strict: false })
 */
export interface MutableStateOptions {
	/**
	 * When bare writes notify listeners. Defaults to a microtask.
	 */
	readonly emitOn?: EmissionScheduler;

	/**
	 * When true, throws at a dangerous edge, at the cause. Defaults to true.
	 */
	readonly strict?: boolean;
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
	const incoming: unknown = properties;

	if (typeof incoming !== "object" || incoming === null) return properties;

	if (isIgnored(incoming)) return properties;

	if (Object.isFrozen(incoming)) return properties;

	const root = rawOf(incoming);

	if (handleOf(incoming) !== undefined) return proxyOf(incoming) as T;

	const strict = options?.strict !== false;
	const exempt = !strict || isUnsafeMarked(root);
	const handle: Handle = {
		root,
		strict,
		emitOn: options?.emitOn,
		subscribers: new Map(),
		pending: [],
		pendingIndex: new Map(),
		isFlushScheduled: false,
	};

	if (strict && !exempt) assertAdmissible(handle, root, [], false);

	const proxy = proxyOf(root);
	const record = recordOf(root);

	if (record === undefined) throw new Error("opshot: node record missing after proxy");

	record.memberships.set(handle, { edges: 1, exempt });

	for (const entry of walkDataEntries(root)) {
		if (isTrackedEntry(handle, root, entry)) attach(handle, root, entry.value);
	}

	return proxy as T;
}
