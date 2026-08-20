import { proxy, snapshot } from "valtio/vanilla";
import { getGroupChain, type Group } from "./createGroup";
import { armWatch } from "./emit/emitter";
import { requireObjectSnapshot } from "./emit/requireObjectSnapshot";
import { registerHandle, type Handle } from "./handle";
import { ignoreMarker, type Ignored } from "./ignore";
import { seedOccupancies } from "./occupancy";
import { isPlainArray } from "./ops/cloneValue";
import { appendOperationPath, createOperationPath, formatOperationPath, type OperationPath } from "./ops/path";
import { isCanonicalArrayIndexString } from "./ops/predicates";
import { unsafeMarker, type UnsafeTracked } from "./unsafeTrack";
import { walkDataEntries } from "./utils/dataEntries";
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
 * The live state shape after factory-argument markers are collapsed.
 *
 * @typeParam T - Factory argument type.
 */
export type Unmarked<T> =
	T extends Ignored<infer Inner>
		? Unmarked<Inner>
		: T extends UnsafeTracked<infer Inner>
			? Unmarked<Inner>
			: T extends (...args: never) => unknown
				? T
				: T extends ReadonlyArray<infer Element>
					? Array<Unmarked<Element>>
					: T extends object
						? { [Key in keyof T]: Unmarked<T[Key]> }
						: T;

const isIgnoredWrapper = (value: unknown): value is Ignored<unknown> =>
	typeof value === "object" && value !== null && Object.hasOwn(value, ignoreMarker);

const isUnsafeWrapper = (value: unknown): value is UnsafeTracked<unknown> =>
	typeof value === "object" && value !== null && Object.hasOwn(value, unsafeMarker);

const segmentFor = (parent: object, key: string): string | number =>
	isPlainArray(parent) && isCanonicalArrayIndexString(key) ? Number(key) : key;

const consumeMarkerTree = (
	node: object,
	path: OperationPath,
	ignoredAt: Set<string>,
	unsafeAt: Set<string>,
	visits: Set<object>,
): void => {
	if (visits.has(node) || Object.isFrozen(node)) return;

	visits.add(node);

	for (const entry of walkDataEntries(node)) {
		const childPath = appendOperationPath(path, segmentFor(node, entry.key));
		const next = unwrapValue(entry.value, childPath, ignoredAt, unsafeAt, visits);

		if (!Object.is(next, entry.value) && entry.writable) Reflect.set(node, entry.key, next);
	}
};

const unwrapValue = (
	value: unknown,
	path: OperationPath,
	ignoredAt: Set<string>,
	unsafeAt: Set<string>,
	visits: Set<object>,
): unknown => {
	let current = value;

	while (isIgnoredWrapper(current) || isUnsafeWrapper(current)) {
		const pathKey = formatOperationPath(path);

		if (isIgnoredWrapper(current)) {
			ignoredAt.add(pathKey);
			current = current[ignoreMarker];
		} else {
			unsafeAt.add(pathKey);
			current = current[unsafeMarker];
		}
	}

	if (typeof current === "object" && current !== null) consumeMarkerTree(current, path, ignoredAt, unsafeAt, visits);

	return current;
};

/**
 * Creates a mutable state object.
 *
 * `ignore()` on a value in the factory argument makes the edge at that path untracked in that state.
 * `unsafeTrack()` on a value in the factory argument disables strict at and under that path.
 *
 * @typeParam T - State shape.
 * @param properties - Initial fields.
 * @param options - Creation options.
 * @returns The state, with factory-argument markers collapsed.
 */
export function createMutableState<T extends object>(properties: T, options?: MutableStateOptions): Unmarked<T> {
	installBoundary();

	const ignoredAt = new Set<string>();
	const unsafeAt = new Set<string>();
	let root: unknown = properties;

	while (isIgnoredWrapper(root) || isUnsafeWrapper(root)) {
		if (isIgnoredWrapper(root)) {
			ignoredAt.add("/");
			root = root[ignoreMarker];
		} else {
			unsafeAt.add("/");
			root = root[unsafeMarker];
		}
	}

	if (ignoredAt.has("/")) return root as Unmarked<T>;

	if (typeof root !== "object" || root === null) return root as Unmarked<T>;

	if (Object.isFrozen(root)) return root as Unmarked<T>;

	const decision = admissionDecision(root);
	const strict = options?.strict !== false;

	if (decision.lane === "leaf") return root as Unmarked<T>;

	const base = Object.create(Reflect.getPrototypeOf(root)) as object;

	Object.defineProperties(base, Object.getOwnPropertyDescriptors(root));
	consumeMarkerTree(base, createOperationPath([]), ignoredAt, unsafeAt, new Set());

	if (decision.lane === "dangerous" && strict && !unsafeAt.has("/")) {
		throw rejectionError(base, decision.kind);
	}

	assertSafeDataPaths(base, [], new Set(), strict ? "admission" : "rootsOnly", ignoredAt, unsafeAt);

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
		unsafeAt,
		ignoredAt,
		members: new WeakSet(),
		routes: new WeakMap(),
		stamp: {},
		version: 0,
		replaying: false,
	};

	registerHandle(base, handle);

	const instrumented = proxy({ root: base });

	handle.proxy = instrumented;
	handle.lastSnapshot = requireObjectSnapshot(snapshot(instrumented.root));
	seedOccupancies(handle);
	armWatch(handle);

	return instrumented.root as Unmarked<T>;
}
