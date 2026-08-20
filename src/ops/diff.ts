import { unstable_getInternalStates } from "valtio/vanilla";
import { getRegisteredTarget, isSameIdentity } from "../identity";
import {
	addOccupancyRoute,
	bindVisitedOccupancy,
	dropOccupancyRoutesUnder,
	isUnderIgnoredOccupancy,
	isUnderUnsafeOccupancy,
	markDirtyPath,
	type CaptureTables,
	type OccupancyVisit,
} from "../occupancy";
import { walkDataEntries } from "../utils/dataEntries";
import { isPlainArray, isPlainObject } from "./cloneValue";
import { canonicalRouteOf, externalRoutesOf, routeUnderPath } from "./commitWalk";
import {
	createAssignMutation,
	createDeleteMutation,
	createLinkMutation,
	getValueOriginal,
	type Operation,
} from "./operation";
import {
	appendOperationPath,
	createOperationPath,
	formatOperationPath,
	operationPathsEqual,
	type OperationPath,
} from "./path";
import { isCanonicalArrayIndexString, isObjectLike } from "./predicates";
import type { DirtyIndex, Handle } from "../handle";

const { proxyStateMap } = unstable_getInternalStates();

const rawTargetOf = (value: object): object => proxyStateMap.get(value)?.[0] ?? value;

type RootKind = "plainObject" | "plainArray";
type Ancestors = Map<object, Set<object>>;

interface DiffContext {
	readonly ops: Array<Operation>;
	readonly ancestors: Ancestors;
	readonly ancestorPaths: Map<object, OperationPath>;
	readonly predatingRoutes: Map<object, ReadonlyArray<OperationPath>>;
	readonly firstRouteThisBatch: Map<object, OperationPath>;
	readonly firstTouchedThisBatch: Map<object, OperationPath>;
	readonly decomposingRemovals: Set<object>;
	readonly beforeRoot: object;
	readonly afterRoot: object;
	readonly linksEnabled: boolean;
	readonly handle: Handle | undefined;
	readonly dirty: DirtyIndex | undefined;
	readonly capture: CaptureTables;
}

class IncompatibleObjectRootsError extends Error {
	constructor() {
		super("opshot: diffObjects requires compatible supported object roots");
		this.name = "IncompatibleObjectRootsError";
	}
}

const additionPair = (path: OperationPath, after: unknown): Operation => ({
	do: createAssignMutation(path, after),
	undo: createDeleteMutation(path),
});

const removalPair = (path: OperationPath, before: unknown): Operation => ({
	do: createDeleteMutation(path),
	undo: createAssignMutation(path, before),
});

const changePair = (path: OperationPath, before: unknown, after: unknown): Operation => ({
	do: createAssignMutation(path, after),
	undo: createAssignMutation(path, before),
});

const liveOf = (node: object): object => getRegisteredTarget(node) ?? node;

const routeKeyOf = (node: object): object => rawTargetOf(liveOf(node));

const segmentFor = (parent: object, key: string): string | number =>
	isPlainArray(parent) && isCanonicalArrayIndexString(key) ? Number(key) : key;

const liveAtPath = (root: object, path: OperationPath): unknown => {
	let current: unknown = root;

	for (const segment of path) {
		if (!isObjectLike(current)) return undefined;

		current = Reflect.get(current, segment);
	}

	return current;
};

const routesOfLive = (context: DiffContext, live: object): ReadonlyArray<OperationPath> => {
	if (context.handle === undefined) return [];

	return context.handle.routes.get(routeKeyOf(live)) ?? [];
};

const rememberPredatingRoutes = (context: DiffContext, live: object): void => {
	if (context.handle === undefined) return;

	const key = routeKeyOf(live);

	if (context.predatingRoutes.has(key)) return;

	context.predatingRoutes.set(key, context.handle.routes.get(key) ?? []);
};

const rememberFirstRouteThisBatch = (context: DiffContext, live: object, path: OperationPath): void => {
	const key = routeKeyOf(live);

	if (!context.firstTouchedThisBatch.has(key)) context.firstTouchedThisBatch.set(key, path);

	if (context.firstRouteThisBatch.has(key)) return;

	const predating = context.predatingRoutes.get(key) ?? [];

	if (predating.some((route) => operationPathsEqual(route, path))) return;

	context.firstRouteThisBatch.set(key, path);
};

const writesTables = (context: DiffContext): context is DiffContext & { handle: Handle; dirty: DirtyIndex } =>
	context.handle !== undefined && context.dirty !== undefined;

const admitEmitPath = (
	context: DiffContext,
	path: OperationPath,
	before: unknown,
	after: unknown,
	beforePresent: boolean,
): OccupancyVisit => {
	if (!writesTables(context) || path.length === 0) return "continue";

	const liveParent = liveAtPath(context.handle.proxy.root, path.slice(0, -1));
	const liveChild = liveAtPath(context.handle.proxy.root, path);
	const lastSegment = path[path.length - 1];

	if (!isObjectLike(liveParent) || lastSegment === undefined) return "continue";

	if (isObjectLike(liveChild)) rememberPredatingRoutes(context, liveChild);

	const sameOccupant = beforePresent && sharesStorageIdentity(before, after);
	const unsafe = isUnderUnsafeOccupancy(context.handle, path);
	const visit = bindVisitedOccupancy(
		context.handle,
		path,
		liveParent,
		lastSegment,
		liveChild,
		context.capture,
		sameOccupant,
		unsafe,
	);

	if (visit === "continue" && isObjectLike(liveChild)) {
		rememberFirstRouteThisBatch(context, liveChild, path);
	}

	return visit;
};

const recordDescendantRoutes = (
	context: DiffContext,
	path: OperationPath,
	visits: Set<object> = new Set(),
	sameOccupant = false,
	unsafe = false,
): void => {
	if (!writesTables(context)) return;

	const liveNode = liveAtPath(context.handle.proxy.root, path);

	if (!isObjectLike(liveNode)) return;

	const nodeKey = rawTargetOf(liveNode);

	if (visits.has(nodeKey)) return;

	visits.add(nodeKey);

	const nodeUnsafe = unsafe || isUnderUnsafeOccupancy(context.handle, path);

	if (isUnderIgnoredOccupancy(context.handle, path)) return;

	for (const entry of walkDataEntries(liveNode)) {
		if (typeof entry.value !== "object" || entry.value === null) continue;

		const childPath = appendOperationPath(path, segmentFor(liveNode, entry.key));
		const childUnsafe = nodeUnsafe || context.handle.unsafeAt.has(formatOperationPath(childPath));

		rememberPredatingRoutes(context, entry.value);

		const visit = bindVisitedOccupancy(
			context.handle,
			childPath,
			liveNode,
			entry.key,
			entry.value,
			context.capture,
			sameOccupant,
			childUnsafe,
		);

		if (visit !== "continue") continue;

		rememberFirstRouteThisBatch(context, entry.value, childPath);
		recordDescendantRoutes(context, childPath, visits, sameOccupant, childUnsafe);
	}
};

const usableRoutesIn = (
	context: DiffContext,
	routes: ReadonlyArray<OperationPath>,
	live: object,
	formation: OperationPath,
): ReadonlyArray<OperationPath> =>
	externalRoutesOf(routes, formation).filter((route) => routeResolvesIn(context.afterRoot, route, live));

const usableExternalRoutesOf = (
	context: DiffContext,
	live: object,
	formation: OperationPath,
): ReadonlyArray<OperationPath> => usableRoutesIn(context, routesOfLive(context, live), live, formation);

const routeResolvesIn = (root: object, route: OperationPath, live: object): boolean => {
	let current: unknown = root;

	for (const segment of route) {
		if (!isObjectLike(current)) return false;

		const container = current as Record<string | number, unknown>;

		if (!Object.hasOwn(container, segment)) return false;

		current = container[segment];
	}

	return isObjectLike(current) && routeKeyOf(current) === routeKeyOf(live);
};

const refForMint = (context: DiffContext, live: object, container: OperationPath): OperationPath | undefined => {
	const routes = routesOfLive(context, live);
	const external = usableRoutesIn(context, routes, live, container);

	if (external.length === 0) return undefined;

	const predating = context.predatingRoutes.get(routeKeyOf(live)) ?? [];
	const predatingUsable = external.find(
		(route) =>
			predating.some((occupied) => operationPathsEqual(occupied, route)) ||
			routeResolvesIn(context.beforeRoot, route, live),
	);

	if (predatingUsable !== undefined) return predatingUsable;

	const firstThisBatch = context.firstRouteThisBatch.get(routeKeyOf(live));

	if (firstThisBatch !== undefined && routeUnderPath(firstThisBatch, container)) return undefined;

	const canonical = canonicalRouteOf(routes);

	if (canonical !== undefined && routeUnderPath(canonical, container)) return undefined;

	return external[0];
};

const assignmentNeedsDecomposition = (context: DiffContext, value: object, formation: OperationPath): boolean => {
	if (!context.linksEnabled) return false;

	const seen = new Set<object>();

	seen.add(liveOf(value));

	const visit = (node: object): boolean => {
		for (const entry of walkDataEntries(node)) {
			const child: unknown = entry.value;

			if (!isObjectLike(child)) continue;

			const live = liveOf(child);

			if (seen.has(live)) return true;

			seen.add(live);

			if (usableExternalRoutesOf(context, live, formation).length > 0) return true;

			if (visit(child)) return true;
		}

		return false;
	};

	return visit(value);
};

const linkOperation = (
	path: OperationPath,
	ref: OperationPath,
	before: unknown,
	beforePresent: boolean,
): Operation => ({
	do: createLinkMutation(path, ref),
	undo: beforePresent ? createAssignMutation(path, before) : createDeleteMutation(path),
});

const carriedUndoLiveOf = (pair: Operation): object | undefined => {
	if (pair.undo.verb !== "assign") return undefined;

	const original = getValueOriginal(pair.undo);

	if (!isObjectLike(original)) return undefined;

	return liveOf(original);
};

const forEachCarriedUndo = (
	context: DiffContext,
	opsStart: number,
	visit: (pair: Operation, live: object, index: number) => boolean,
): void => {
	for (let index = opsStart; index < context.ops.length; index++) {
		const pair = context.ops[index];

		if (pair === undefined) continue;

		const live = carriedUndoLiveOf(pair);

		if (live === undefined) continue;

		if (visit(pair, live, index)) return;
	}
};

const commitOperation = (context: DiffContext, pair: Operation): void => {
	context.ops.push(pair);
};

const insertOperation = (context: DiffContext, index: number, pair: Operation): void => {
	context.ops.splice(index, 0, pair);
};

const commitLink = (
	context: DiffContext,
	path: OperationPath,
	ref: OperationPath,
	before: unknown,
	beforePresent: boolean,
): void => {
	commitOperation(context, linkOperation(path, ref, before, beforePresent));
};

const emptyContainerOf = (value: object): object => (isPlainArray(value) ? [] : {});

const mintDecomposedContents = (context: DiffContext, path: OperationPath, after: object): void => {
	if (isPlainArray(after)) {
		if (after.length > 0) commitOperation(context, changePair(appendOperationPath(path, "length"), 0, after.length));

		for (let index = 0; index < after.length; index++) {
			if (!Object.hasOwn(after, index)) continue;

			pushAddition(context, appendOperationPath(path, index), after[index]);
		}

		diffObjectProperties(context, [], after, path, true);
	} else {
		for (const entry of walkDataEntries(after)) {
			pushAddition(context, appendOperationPath(path, entry.key), entry.value);
		}
	}
};

const mintDecomposedAddition = (context: DiffContext, path: OperationPath, after: object): void => {
	commitOperation(context, {
		do: createAssignMutation(path, emptyContainerOf(after), after),
		undo: createDeleteMutation(path),
	});
	mintDecomposedContents(context, path, after);
};

const mintDecomposedRemoval = (context: DiffContext, path: OperationPath, before: object): void => {
	const live = liveOf(before);
	const key = routeKeyOf(live);

	if (context.decomposingRemovals.has(key)) {
		commitOperation(context, removalPair(path, before));

		return;
	}

	context.decomposingRemovals.add(key);
	rememberPredatingRoutes(context, live);
	rememberFirstRouteThisBatch(context, live, path);

	if (isPlainArray(before)) {
		for (let index = 0; index < before.length; index++) {
			if (!Object.hasOwn(before, index)) continue;

			pushRemoval(context, appendOperationPath(path, index), before[index]);
		}

		diffObjectProperties(context, before, [], path, true);
	} else {
		for (const entry of walkDataEntries(before)) {
			pushRemoval(context, appendOperationPath(path, entry.key), entry.value);
		}
	}

	commitOperation(context, {
		do: createDeleteMutation(path),
		undo: createAssignMutation(path, emptyContainerOf(before), before),
	});
};

const mintDecomposedChange = (context: DiffContext, path: OperationPath, before: unknown, after: object): void => {
	if (
		isObjectLike(before) &&
		assignmentNeedsDecomposition(context, before, path) &&
		usableExternalRoutesOf(context, liveOf(before), path).length === 0
	) {
		mintDecomposedRemoval(context, path, before);
		mintDecomposedAddition(context, path, after);

		return;
	}

	commitOperation(context, {
		do: createAssignMutation(path, emptyContainerOf(after), after),
		undo: createAssignMutation(path, before),
	});
	mintDecomposedContents(context, path, after);
};

const mintAssignment = (
	context: DiffContext,
	path: OperationPath,
	before: unknown,
	after: unknown,
	beforePresent: boolean,
): void => {
	if (isSkippedPath(context, path)) return;

	const assigned = withoutOmittedChildren(context, after, path);

	if (isObjectLike(assigned) && context.linksEnabled) {
		const live = liveOf(assigned);
		const ancestorPath = context.ancestorPaths.get(live);

		if (ancestorPath !== undefined) {
			commitLink(context, path, ancestorPath, before, beforePresent);

			return;
		}

		const ref = refForMint(context, live, path);

		if (ref !== undefined) {
			commitLink(context, path, ref, before, beforePresent);

			return;
		}

		const recorded = context.firstRouteThisBatch.get(routeKeyOf(live));

		if (
			recorded !== undefined &&
			!operationPathsEqual(recorded, path) &&
			routeResolvesIn(context.afterRoot, recorded, live)
		) {
			commitLink(context, path, recorded, before, beforePresent);

			return;
		}

		if (
			(isPlainObject(assigned) || isPlainArray(assigned)) &&
			assignmentNeedsDecomposition(context, assigned, path)
		) {
			if (!beforePresent) {
				mintDecomposedAddition(context, path, assigned);

				return;
			}

			mintDecomposedChange(context, path, before, assigned);

			return;
		}

		if (writesTables(context)) {
			rememberPredatingRoutes(context, live);
			addOccupancyRoute(context.handle, live, path);
			rememberFirstRouteThisBatch(context, live, path);
		}
	}

	if (beforePresent) commitOperation(context, changePair(path, before, assigned));
	else commitOperation(context, additionPair(path, assigned));

	if (isObjectLike(assigned) && writesTables(context) && !isSkippedPath(context, path)) {
		recordDescendantRoutes(context, path);
	}
};

const markChangedPath = (context: DiffContext, path: OperationPath): void => {
	if (!writesTables(context) || path.length === 0) return;

	const liveParent = liveAtPath(context.handle.proxy.root, path.slice(0, -1));

	if (!isObjectLike(liveParent)) return;

	markDirtyPath(context.dirty, context.handle, path, liveParent);
};

const pushAddition = (context: DiffContext, path: OperationPath, after: unknown): void => {
	const visit = admitEmitPath(context, path, undefined, after, false);

	if (visit === "omit") return;

	if (visit === "skip" && isOmittedPath(context, path)) return;

	if (context.handle !== undefined && isUnderIgnoredOccupancy(context.handle, path)) return;

	markChangedPath(context, path);

	mintAssignment(context, path, undefined, after, false);
};

const pushRemoval = (context: DiffContext, path: OperationPath, before: unknown): void => {
	if (isSkippedPath(context, path)) return;

	if (isObjectLike(before) && context.linksEnabled) {
		rememberPredatingRoutes(context, before);
		rememberFirstRouteThisBatch(context, before, path);
	}

	if (writesTables(context)) {
		dropOccupancyRoutesUnder(context.handle, path);
		markChangedPath(context, path);
	}

	if (isObjectLike(before) && context.linksEnabled) {
		const live = liveOf(before);
		const recorded =
			context.firstTouchedThisBatch.get(routeKeyOf(live)) ?? context.firstRouteThisBatch.get(routeKeyOf(live));

		if (recorded !== undefined && !operationPathsEqual(recorded, path)) {
			const pair: Operation = {
				do: createDeleteMutation(path),
				undo: createLinkMutation(path, recorded),
			};
			let insertAt = context.ops.length;

			for (let index = 0; index < context.ops.length; index++) {
				const existing = context.ops[index];

				if (existing === undefined) continue;

				if (existing.do.verb === "delete" && operationPathsEqual(existing.do.path, recorded)) {
					insertAt = index;

					break;
				}
			}

			insertOperation(context, insertAt, pair);

			return;
		}

		if (
			assignmentNeedsDecomposition(context, before, path) &&
			usableExternalRoutesOf(context, live, path).length === 0
		) {
			mintDecomposedRemoval(context, path, before);

			return;
		}
	}

	commitOperation(context, removalPair(path, before));
};

const pushChange = (context: DiffContext, path: OperationPath, before: unknown, after: unknown): void => {
	markChangedPath(context, path);

	mintAssignment(context, path, before, after, true);
};

const hasAncestorPair = (ancestors: Ancestors, before: object, after: object): boolean =>
	ancestors.get(before)?.has(after) ?? false;

const enterAncestorPair = (ancestors: Ancestors, before: object, after: object): void => {
	const afterSet = ancestors.get(before) ?? new Set<object>();

	afterSet.add(after);
	ancestors.set(before, afterSet);
};

const exitAncestorPair = (ancestors: Ancestors, before: object, after: object): void => {
	const afterSet = ancestors.get(before);

	if (!afterSet) return;

	afterSet.delete(after);

	if (afterSet.size === 0) ancestors.delete(before);
};

const sharesStorageIdentity = (before: unknown, after: unknown): boolean =>
	isObjectLike(before) && isObjectLike(after) && isSameIdentity(before, after);

const isOmittedPath = (context: DiffContext, path: OperationPath): boolean => {
	if (context.capture.omissions.size === 0) return false;

	const pathKey = formatOperationPath(path);

	if (context.capture.omissions.has(pathKey)) return true;

	for (const omitted of context.capture.omissions) {
		if (omitted === "/") return true;

		if (pathKey.startsWith(`${omitted}/`)) return true;
	}

	return false;
};

const isSkippedPath = (context: DiffContext, path: OperationPath): boolean => {
	if (isOmittedPath(context, path)) return true;

	if (context.handle === undefined || path.length === 0) return false;

	return isUnderIgnoredOccupancy(context.handle, path);
};

const withoutOmittedChildren = (context: DiffContext, value: unknown, path: OperationPath): unknown => {
	if (!isObjectLike(value) || context.capture.omissions.size === 0) return value;

	let clone: Record<string, unknown> | Array<unknown> | undefined;

	const written = (): Record<string, unknown> | Array<unknown> => {
		if (clone !== undefined) return clone;

		clone = isPlainArray(value) ? value.slice() : { ...(value as Record<string, unknown>) };

		return clone;
	};

	for (const entry of walkDataEntries(value)) {
		const childPath = appendOperationPath(path, entry.key);

		if (isOmittedPath(context, childPath)) {
			const next = written();

			if (Array.isArray(next)) Reflect.deleteProperty(next, Number(entry.key));
			else Reflect.deleteProperty(next, entry.key);

			continue;
		}

		const stripped = withoutOmittedChildren(context, entry.value, childPath);

		if (stripped === entry.value) continue;

		(written() as Record<string, unknown>)[entry.key] = stripped;
	}

	return clone ?? value;
};

const dataEntryValuesOf = (value: object, ignoreArrayIndexes: boolean): Map<string, unknown> => {
	const entries = new Map<string, unknown>();

	for (const entry of walkDataEntries(value)) {
		if (ignoreArrayIndexes && isCanonicalArrayIndexString(entry.key)) continue;

		entries.set(entry.key, entry.value);
	}

	return entries;
};

const diffObjectProperties = (
	context: DiffContext,
	before: Record<string, unknown> | Array<unknown>,
	after: Record<string, unknown> | Array<unknown>,
	path: OperationPath,
	ignoreArrayIndexes: boolean,
): void => {
	const beforeEntries = dataEntryValuesOf(before, ignoreArrayIndexes);
	const afterEntries = dataEntryValuesOf(after, ignoreArrayIndexes);
	const keys = new Set<string>([...beforeEntries.keys(), ...afterEntries.keys()]);

	for (const key of keys) {
		const nextPath = appendOperationPath(path, key);
		const beforePresent = beforeEntries.has(key);
		const afterPresent = afterEntries.has(key);

		if (beforePresent && afterPresent) {
			diffValue(context, beforeEntries.get(key), afterEntries.get(key), nextPath);
		} else if (beforePresent && !Object.hasOwn(after, key)) {
			pushRemoval(context, nextPath, beforeEntries.get(key));
		} else if (afterPresent && !Object.hasOwn(before, key)) {
			pushAddition(context, nextPath, afterEntries.get(key));
		}
	}
};

const diffArray = (context: DiffContext, before: Array<unknown>, after: Array<unknown>, path: OperationPath): void => {
	const overlap = Math.min(before.length, after.length);

	for (let index = 0; index < overlap; index++) {
		const beforePresent = Object.hasOwn(before, index);
		const afterPresent = Object.hasOwn(after, index);

		if (!beforePresent && !afterPresent) continue;

		const nextPath = appendOperationPath(path, index);

		if (!beforePresent) pushAddition(context, nextPath, after[index]);
		else if (!afterPresent) pushRemoval(context, nextPath, before[index]);
		else diffValue(context, before[index], after[index], nextPath);
	}

	if (after.length > before.length) {
		pushChange(context, appendOperationPath(path, "length"), before.length, after.length);

		for (let index = before.length; index < after.length; index++) {
			if (Object.hasOwn(after, index)) pushAddition(context, appendOperationPath(path, index), after[index]);
		}
	} else if (after.length < before.length) {
		for (let index = after.length; index < before.length; index++) {
			if (Object.hasOwn(before, index)) pushRemoval(context, appendOperationPath(path, index), before[index]);
		}

		pushChange(context, appendOperationPath(path, "length"), before.length, after.length);
	}

	diffObjectProperties(context, before, after, path, true);
};

const walkContainer = (
	context: DiffContext,
	before: object,
	after: object,
	path: OperationPath,
	walk: () => void,
): void => {
	if (hasAncestorPair(context.ancestors, before, after)) return;

	enterAncestorPair(context.ancestors, before, after);

	const afterLive = liveOf(after);
	const priorPath = context.ancestorPaths.get(afterLive);

	if (priorPath === undefined) context.ancestorPaths.set(afterLive, path);

	try {
		walk();
	} finally {
		if (priorPath === undefined) context.ancestorPaths.delete(afterLive);

		exitAncestorPair(context.ancestors, before, after);
	}
};

const diffValue = (context: DiffContext, before: unknown, after: unknown, path: OperationPath): void => {
	const replacing =
		path.length > 0 && isObjectLike(before) && isObjectLike(after) && !sharesStorageIdentity(before, after);

	if (replacing && writesTables(context)) dropOccupancyRoutesUnder(context.handle, path);

	const visit = admitEmitPath(context, path, before, after, isObjectLike(before) || before !== undefined);

	if (visit === "omit") return;

	if (visit === "skip" || isSkippedPath(context, path)) {
		if (isOmittedPath(context, path) || Object.is(before, after)) return;

		if (isObjectLike(before) && isObjectLike(after) && sharesStorageIdentity(before, after)) return;

		if (context.handle !== undefined && isUnderIgnoredOccupancy(context.handle, path)) return;

		markChangedPath(context, path);

		pushChange(context, path, before, after);

		return;
	}

	if (Object.is(before, after)) {
		if (writesTables(context)) recordDescendantRoutes(context, path, new Set(), true);

		return;
	}

	if (replacing) {
		markChangedPath(context, path);

		pushChange(context, path, before, after);

		return;
	}

	if (isPlainArray(before) && isPlainArray(after)) {
		walkContainer(context, before, after, path, () => diffArray(context, before, after, path));

		return;
	}

	if (isPlainObject(before) && isPlainObject(after)) {
		walkContainer(context, before, after, path, () => diffObjectProperties(context, before, after, path, false));

		return;
	}

	markChangedPath(context, path);

	pushChange(context, path, before, after);
};

const getRootKind = (value: object): RootKind | undefined => {
	if (isPlainArray(value)) return "plainArray";

	if (isPlainObject(value)) return "plainObject";

	return undefined;
};

interface DoPathTrieNode {
	terminalMax: number;
	readonly children: Map<string | number, DoPathTrieNode>;
}

const createDoPathTrie = (ops: ReadonlyArray<Operation>): ((route: OperationPath, afterIndex: number) => boolean) => {
	const root: DoPathTrieNode = { terminalMax: -1, children: new Map() };

	for (let index = 0; index < ops.length; index++) {
		const pair = ops[index];

		if (pair === undefined) continue;

		let current = root;

		for (const segment of pair.do.path) {
			let child = current.children.get(segment);

			if (child === undefined) {
				child = { terminalMax: -1, children: new Map() };
				current.children.set(segment, child);
			}

			current = child;
		}

		current.terminalMax = Math.max(current.terminalMax, index);
	}

	return (route: OperationPath, afterIndex: number): boolean => {
		let current = root;

		if (current.terminalMax > afterIndex) return true;

		for (const segment of route) {
			const child = current.children.get(segment);

			if (child === undefined) return false;

			current = child;

			if (current.terminalMax > afterIndex) return true;
		}

		return false;
	};
};

const rewriteSurvivingUndos = (context: DiffContext): void => {
	if (!context.linksEnabled) return;

	const routeDisturbedAfter = createDoPathTrie(context.ops);

	forEachCarriedUndo(context, 0, (pair, live, index) => {
		const surviving = usableExternalRoutesOf(context, live, pair.do.path).find(
			(route) => !routeDisturbedAfter(route, index),
		);

		if (surviving === undefined) return false;

		context.ops[index] = {
			do: pair.do,
			undo: createLinkMutation(pair.do.path, surviving),
		};

		return false;
	});
};

/**
 * Diffs two plain objects into ops.
 *
 * @param before - Earlier value.
 * @param after - Later value.
 * @returns Ops from before to after.
 */
export function diffObjects(
	before: object,
	after: object,
	handle?: Handle,
	dirty?: DirtyIndex,
	capture?: CaptureTables,
): Array<Operation> {
	const beforeKind = getRootKind(before);
	const afterKind = getRootKind(after);

	if (beforeKind === undefined || beforeKind !== afterKind) throw new IncompatibleObjectRootsError();

	const ops = new Array<Operation>();
	const linksEnabled = handle !== undefined;

	const context: DiffContext = {
		ops,
		ancestors: new Map(),
		ancestorPaths: new Map(),
		predatingRoutes: new Map(),
		firstRouteThisBatch: new Map(),
		firstTouchedThisBatch: new Map(),
		decomposingRemovals: new Set(),
		beforeRoot: before,
		afterRoot: after,
		linksEnabled,
		handle,
		dirty,
		capture: capture ?? { refusals: [], omissions: new Set() },
	};

	diffValue(context, before, after, createOperationPath([]));
	rewriteSurvivingUndos(context);

	return ops;
}
