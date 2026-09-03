import { attachRoot } from "./edges";
import { handleOf, type Handle } from "./handle";
import { isIgnored } from "./ignore";
import { installProxyHandler, proxyOf, rawOf } from "./node";
import { handler } from "./proxy";
import { isUnsafeMarked } from "./unsafeTrack";

installProxyHandler(handler);

/**
 * Sets when a state's window flushes. Call `flush` once.
 *
 * @param flush - Delivers pending operations.
 * @returns Nothing.
 */
export type EmissionScheduler = (flush: () => void) => void;

/**
 * Options for `createMutableState`.
 *
 * @example
 * createMutableState({ count: 0 }, { emitOn, strict: false })
 */
export interface MutableStateOptions {
	/**
	 * When the window flushes for all writes. Defaults to a microtask.
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

	const proxy = proxyOf(root);

	attachRoot(handle, root, exempt);

	return proxy as T;
}
