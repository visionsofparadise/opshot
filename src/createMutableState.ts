import { proxy, snapshot } from "valtio/vanilla";
import { getGroupChain, type Group } from "./createGroup";
import {
	createDeclarationTrie,
	declarationAtPath,
	graftDeclarationChildren,
	hasDeclarations,
	type MutableDeclarationTrie,
} from "./declarations";
import { seedInEdges } from "./edges";
import { armWatch } from "./emit/emitter";
import { requireObjectSnapshot } from "./emit/requireObjectSnapshot";
import { registerHandle, type Handle } from "./handle";
import { ignoreMarker, type Ignored } from "./ignore";
import { isState } from "./isState";
import { seedOccupancies } from "./occupancy";
import { isPlainArray } from "./ops/cloneValue";
import { appendOperationPath, createOperationPath, type OperationPath } from "./ops/path";
import { isCanonicalArrayIndexString } from "./ops/predicates";
import { peelReadProxy } from "./peelReadProxy";
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

interface MarkerWalk {
	readonly trie: MutableDeclarationTrie;
	marked: boolean;
	readonly firstOccupancyByNode: Map<object, OperationPath>;
	readonly laterOccupanciesByNode: Map<object, Array<OperationPath>>;
}

const consumeMarkerTree = (node: object, path: OperationPath, walk: MarkerWalk): void => {
	if (Object.isFrozen(node)) return;

	const firstPath = walk.firstOccupancyByNode.get(node);

	if (firstPath !== undefined) {
		const laterOccupancies = walk.laterOccupanciesByNode.get(node);

		if (laterOccupancies === undefined) walk.laterOccupanciesByNode.set(node, [path]);
		else laterOccupancies.push(path);

		return;
	}

	walk.firstOccupancyByNode.set(node, path);

	for (const entry of walkDataEntries(node)) {
		const childPath = appendOperationPath(path, segmentFor(node, entry.key));
		const next = unwrapValue(entry.value, childPath, walk);

		if (!Object.is(next, entry.value) && entry.writable) Reflect.set(node, entry.key, next);
	}
};

const unwrapValue = (value: unknown, path: OperationPath, walk: MarkerWalk): unknown => {
	let current = value;

	while (isIgnoredWrapper(current) || isUnsafeWrapper(current)) {
		const node = declarationAtPath(walk.trie, path);

		walk.marked = true;

		if (isIgnoredWrapper(current)) {
			node.ignored = true;
			current = current[ignoreMarker];
		} else {
			node.unsafe = true;
			current = current[unsafeMarker];
		}
	}

	if (typeof current === "object" && current !== null) consumeMarkerTree(current, path, walk);

	return current;
};

const trieAtPath = (trie: MutableDeclarationTrie, path: OperationPath): MutableDeclarationTrie | undefined => {
	let current: MutableDeclarationTrie | undefined = trie;

	for (const segment of path) {
		current = current.children.get(String(segment));

		if (current === undefined) return undefined;
	}

	return current;
};

const applyCopiedMarkerPaths = (walk: MarkerWalk): void => {
	for (const [node, firstPath] of walk.firstOccupancyByNode) {
		const laterOccupancies = walk.laterOccupanciesByNode.get(node);

		if (laterOccupancies === undefined) continue;

		const source = trieAtPath(walk.trie, firstPath);

		if (source === undefined || source.children.size === 0) continue;

		for (const laterPath of laterOccupancies) {
			graftDeclarationChildren(source, declarationAtPath(walk.trie, laterPath));
		}
	}
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

	const trie = createDeclarationTrie();
	let marked = false;
	let root: unknown = properties;

	while (isIgnoredWrapper(root) || isUnsafeWrapper(root)) {
		if (isIgnoredWrapper(root)) {
			trie.ignored = true;
			marked = true;
			root = root[ignoreMarker];
		} else {
			trie.unsafe = true;
			marked = true;
			root = root[unsafeMarker];
		}
	}

	if (trie.ignored) return root as Unmarked<T>;

	if (typeof root !== "object" || root === null) return root as Unmarked<T>;

	if (Object.isFrozen(root)) return root as Unmarked<T>;

	if (isState(root)) {
		const peeled = peelReadProxy(root);

		if (typeof peeled === "object" && peeled !== null) return peeled as Unmarked<T>;
	}

	const decision = admissionDecision(root);
	const strict = options?.strict !== false;

	if (decision.lane === "leaf") return root as Unmarked<T>;

	const base = Object.create(Reflect.getPrototypeOf(root)) as object;

	Object.defineProperties(base, Object.getOwnPropertyDescriptors(root));

	const walk: MarkerWalk = {
		trie,
		marked,
		firstOccupancyByNode: new Map(),
		laterOccupanciesByNode: new Map(),
	};

	consumeMarkerTree(base, createOperationPath([]), walk);
	applyCopiedMarkerPaths(walk);

	const declarations = walk.marked || hasDeclarations(trie) ? trie : undefined;

	if (decision.lane === "dangerous" && strict && declarations?.unsafe !== true) {
		throw rejectionError(base, decision.kind);
	}

	assertSafeDataPaths(base, [], new Set(), strict ? "admission" : "rootsOnly", [declarations]);

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
		declarations,
		nodes: new WeakMap(),
		byId: new Map(),
		nextInternId: 1,
		stamp: {},
		version: 0,
		replaying: false,
	};

	registerHandle(base, handle);
	handle.nodes.set(base, { edges: [], id: 0 });
	handle.byId.set(0, base);

	const instrumented = proxy({ root: base });

	handle.proxy = instrumented;
	handle.lastSnapshot = requireObjectSnapshot(snapshot(instrumented.root));
	seedInEdges(handle);
	seedOccupancies(handle);
	armWatch(handle);

	return instrumented.root as Unmarked<T>;
}
