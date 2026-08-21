import { unstable_getInternalStates } from "valtio/vanilla";
import { declarationChild, type DeclarationTrie } from "../declarations";
import { edgeStatusOf, isIgnoredFrontier } from "../edges";
import { getRegisteredTarget, isSameIdentity } from "../identity";
import {
	addOccupancyRoute,
	bindVisitedOccupancy,
	createCaptureTables,
	dropOccupancyRoutesUnder,
	markDirtyPath,
	overlayRoutesOf,
	predatingRoutesOf,
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

class MissingDiffHandleError extends Error {
	constructor() {
		super("opshot: diff context is missing a handle");
		this.name = "MissingDiffHandleError";
	}
}

class MissingDiffParentError extends Error {
	constructor() {
		super("opshot: admitEmitPath could not resolve a live parent");
		this.name = "MissingDiffParentError";
	}
}

class MissingAncestorPairError extends Error {
	constructor() {
		super("opshot: exitAncestorPair without matching enterAncestorPair");
		this.name = "MissingAncestorPairError";
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
	if (context.handle === undefined) throw new MissingDiffHandleError();

	return overlayRoutesOf(context.handle, context.capture, live);
};

const predatingOf = (context: DiffContext, live: object): ReadonlyArray<OperationPath> => {
	if (context.handle === undefined) throw new MissingDiffHandleError();

	return predatingRoutesOf(context.handle, live);
};

const earliestAddedRouteOf = (context: DiffContext, live: object): OperationPath | undefined =>
	context.capture.routes.added.get(routeKeyOf(live))?.[0];

const firstTouchedOf = (context: DiffContext, live: object): OperationPath | undefined =>
	context.capture.routes.firstTouched.get(routeKeyOf(live));

const writesTables = (context: DiffContext): context is DiffContext & { handle: Handle; dirty: DirtyIndex } =>
	context.handle !== undefined && context.dirty !== undefined;

const admitEmitPath = (
	context: DiffContext,
	path: OperationPath,
	before: unknown,
	after: unknown,
	beforePresent: boolean,
	residual: DeclarationTrie | undefined,
): OccupancyVisit => {
	if (!writesTables(context) || path.length === 0) return "continue";

	if (residual?.ignored === true) return "skip";

	const liveParent = liveAtPath(context.handle.proxy.root, path.slice(0, -1));
	const liveChild = liveAtPath(context.handle.proxy.root, path);
	const lastSegment = path[path.length - 1];

	if (
		isObjectLike(liveParent) &&
		lastSegment !== undefined &&
		isIgnoredFrontier(context.handle, liveParent, lastSegment)
	)
		return "skip";

	if (!isObjectLike(liveParent) || lastSegment === undefined) throw new MissingDiffParentError();

	const sameOccupant = beforePresent && sharesStorageIdentity(before, after);
	let unsafe = residual?.unsafe === true;

	if (isObjectLike(liveChild)) {
		const status = edgeStatusOf(context.handle, liveChild);

		if (status.occupied) unsafe = status.unsafe;
	}

	return bindVisitedOccupancy(
		context.handle,
		path,
		liveParent,
		lastSegment,
		liveChild,
		context.capture,
		sameOccupant,
		unsafe,
	);
};

const recordDescendantRoutes = (
	context: DiffContext,
	path: OperationPath,
	visits: Set<object> = new Set(),
	sameOccupant = false,
	residual?: DeclarationTrie,
	unsafe = false,
): void => {
	if (context.handle === undefined) throw new MissingDiffHandleError();

	const liveNode = liveAtPath(context.handle.proxy.root, path);

	if (!isObjectLike(liveNode)) return;

	const nodeKey = rawTargetOf(liveNode);

	if (visits.has(nodeKey)) return;

	visits.add(nodeKey);

	if (residual?.ignored === true) return;

	const nodeUnsafe = unsafe || residual?.unsafe === true;

	for (const entry of walkDataEntries(liveNode)) {
		if (typeof entry.value !== "object" || entry.value === null) continue;

		const key = segmentFor(liveNode, entry.key);
		const childPath = appendOperationPath(path, key);
		const childResidual = declarationChild(residual, key);

		if (childResidual?.ignored === true) continue;

		const childUnsafe = nodeUnsafe || childResidual?.unsafe === true;

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

		recordDescendantRoutes(context, childPath, visits, sameOccupant, childResidual, childUnsafe);
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

	const predating = predatingOf(context, live);
	const predatingUsable = external.find(
		(route) =>
			predating.some((occupied) => operationPathsEqual(occupied, route)) ||
			routeResolvesIn(context.beforeRoot, route, live),
	);

	if (predatingUsable !== undefined) return predatingUsable;

	const firstThisBatch = earliestAddedRouteOf(context, live);

	if (firstThisBatch !== undefined && routeUnderPath(firstThisBatch, container)) return undefined;

	const canonical = canonicalRouteOf(routes);

	if (canonical !== undefined && routeUnderPath(canonical, container)) return undefined;

	return external[0];
};

const assignmentNeedsDecomposition = (context: DiffContext, value: object, formation: OperationPath): boolean => {
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
	let index = opsStart;

	for (const pair of context.ops.slice(opsStart)) {
		const live = carriedUndoLiveOf(pair);

		if (live === undefined) {
			index += 1;

			continue;
		}

		if (visit(pair, live, index)) return;

		index += 1;
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

const mintDecomposedContents = (
	context: DiffContext,
	path: OperationPath,
	after: object,
	residual: DeclarationTrie | undefined,
): void => {
	if (isPlainArray(after)) {
		if (after.length > 0) commitOperation(context, changePair(appendOperationPath(path, "length"), 0, after.length));

		for (let index = 0; index < after.length; index++) {
			if (!Object.hasOwn(after, index)) continue;

			pushAddition(context, appendOperationPath(path, index), after[index], declarationChild(residual, index));
		}

		diffObjectProperties(context, [], after, path, true, residual);
	} else {
		for (const entry of walkDataEntries(after)) {
			pushAddition(
				context,
				appendOperationPath(path, entry.key),
				entry.value,
				declarationChild(residual, entry.key),
			);
		}
	}
};

const mintDecomposedAddition = (
	context: DiffContext,
	path: OperationPath,
	after: object,
	residual: DeclarationTrie | undefined,
): void => {
	commitOperation(context, {
		do: createAssignMutation(path, emptyContainerOf(after), after),
		undo: createDeleteMutation(path),
	});
	mintDecomposedContents(context, path, after, residual);
};

const mintDecomposedRemoval = (
	context: DiffContext,
	path: OperationPath,
	before: object,
	residual: DeclarationTrie | undefined,
): void => {
	const live = liveOf(before);
	const key = routeKeyOf(live);

	if (context.decomposingRemovals.has(key)) {
		commitOperation(context, removalPair(path, before));

		return;
	}

	context.decomposingRemovals.add(key);

	if (isPlainArray(before)) {
		for (let index = 0; index < before.length; index++) {
			if (!Object.hasOwn(before, index)) continue;

			pushRemoval(context, appendOperationPath(path, index), before[index], declarationChild(residual, index));
		}

		diffObjectProperties(context, before, [], path, true, residual);
	} else {
		for (const entry of walkDataEntries(before)) {
			pushRemoval(context, appendOperationPath(path, entry.key), entry.value, declarationChild(residual, entry.key));
		}
	}

	commitOperation(context, {
		do: createDeleteMutation(path),
		undo: createAssignMutation(path, emptyContainerOf(before), before),
	});
};

const mintDecomposedChange = (
	context: DiffContext,
	path: OperationPath,
	before: unknown,
	after: object,
	residual: DeclarationTrie | undefined,
): void => {
	if (
		isObjectLike(before) &&
		assignmentNeedsDecomposition(context, before, path) &&
		usableExternalRoutesOf(context, liveOf(before), path).length === 0
	) {
		mintDecomposedRemoval(context, path, before, residual);
		mintDecomposedAddition(context, path, after, residual);

		return;
	}

	commitOperation(context, {
		do: createAssignMutation(path, emptyContainerOf(after), after),
		undo: createAssignMutation(path, before),
	});
	mintDecomposedContents(context, path, after, residual);
};

const collectDescendantOmissions = (
	context: DiffContext,
	path: OperationPath,
	residual: DeclarationTrie | undefined,
): void => {
	if (!writesTables(context)) return;

	recordDescendantRoutes(
		{
			...context,
			capture: {
				refusals: context.capture.refusals,
				omissions: context.capture.omissions,
				routes: { added: new Map(), droppedUnder: [], firstTouched: new Map() },
			},
		},
		path,
		new Set(),
		false,
		residual,
	);
};

const mintAssignment = (
	context: DiffContext,
	path: OperationPath,
	before: unknown,
	after: unknown,
	beforePresent: boolean,
	residual: DeclarationTrie | undefined,
): void => {
	if (isSkippedPath(context, path, residual)) return;

	if (isObjectLike(after) && context.linksEnabled) {
		const live = liveOf(after);
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

		const recorded = earliestAddedRouteOf(context, live);

		if (
			recorded !== undefined &&
			!operationPathsEqual(recorded, path) &&
			routeResolvesIn(context.afterRoot, recorded, live)
		) {
			commitLink(context, path, recorded, before, beforePresent);

			return;
		}

		if ((isPlainObject(after) || isPlainArray(after)) && assignmentNeedsDecomposition(context, after, path)) {
			if (!beforePresent) {
				mintDecomposedAddition(context, path, after, residual);

				return;
			}

			mintDecomposedChange(context, path, before, after, residual);

			return;
		}

		if (writesTables(context)) {
			addOccupancyRoute(context.handle, live, path, context.capture);
		}
	}

	if (isObjectLike(after)) collectDescendantOmissions(context, path, residual);

	const assigned = withoutOmittedChildren(context, after, path);

	if (beforePresent) commitOperation(context, changePair(path, before, assigned));
	else commitOperation(context, additionPair(path, assigned));

	if (isObjectLike(assigned) && writesTables(context) && !isSkippedPath(context, path, residual)) {
		recordDescendantRoutes(context, path, new Set(), false, residual);
	}
};

const markChangedPath = (context: DiffContext, path: OperationPath): void => {
	if (!writesTables(context) || path.length === 0) return;

	const liveParent = liveAtPath(context.handle.proxy.root, path.slice(0, -1));

	if (!isObjectLike(liveParent)) return;

	markDirtyPath(context.dirty, context.handle, path, liveParent);
};

const pushAddition = (
	context: DiffContext,
	path: OperationPath,
	after: unknown,
	residual: DeclarationTrie | undefined,
): void => {
	const visit = admitEmitPath(context, path, undefined, after, false, residual);

	if (visit === "omit") return;

	if (visit === "skip" && isOmittedPath(context, path)) return;

	if (isIgnoredPath(context, path, residual)) return;

	markChangedPath(context, path);

	mintAssignment(context, path, undefined, after, false, residual);
};

const pushRemoval = (
	context: DiffContext,
	path: OperationPath,
	before: unknown,
	residual: DeclarationTrie | undefined,
): void => {
	if (isSkippedPath(context, path, residual)) return;

	if (writesTables(context)) {
		dropOccupancyRoutesUnder(path, context.capture);
		markChangedPath(context, path);
	}

	if (isObjectLike(before) && context.linksEnabled) {
		const live = liveOf(before);
		const recorded = firstTouchedOf(context, live) ?? earliestAddedRouteOf(context, live);

		if (recorded !== undefined && !operationPathsEqual(recorded, path)) {
			const pair: Operation = {
				do: createDeleteMutation(path),
				undo: createLinkMutation(path, recorded),
			};
			let insertAt = context.ops.length;

			let index = 0;

			for (const existing of context.ops) {
				if (existing.do.verb === "delete" && operationPathsEqual(existing.do.path, recorded)) {
					insertAt = index;

					break;
				}

				index += 1;
			}

			insertOperation(context, insertAt, pair);

			return;
		}

		if (
			assignmentNeedsDecomposition(context, before, path) &&
			usableExternalRoutesOf(context, live, path).length === 0
		) {
			mintDecomposedRemoval(context, path, before, residual);

			return;
		}
	}

	commitOperation(context, removalPair(path, before));
};

const pushChange = (
	context: DiffContext,
	path: OperationPath,
	before: unknown,
	after: unknown,
	residual: DeclarationTrie | undefined,
): void => {
	markChangedPath(context, path);

	mintAssignment(context, path, before, after, true, residual);
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

	if (afterSet === undefined) throw new MissingAncestorPairError();

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

const isIgnoredPath = (context: DiffContext, path: OperationPath, residual: DeclarationTrie | undefined): boolean => {
	if (residual?.ignored === true) return true;

	if (context.handle === undefined || path.length === 0) return false;

	const parent = liveAtPath(context.handle.proxy.root, path.slice(0, -1));
	const key = path[path.length - 1];

	return isObjectLike(parent) && key !== undefined && isIgnoredFrontier(context.handle, parent, key);
};

const isSkippedPath = (context: DiffContext, path: OperationPath, residual: DeclarationTrie | undefined): boolean => {
	if (isOmittedPath(context, path)) return true;

	if (context.handle === undefined || path.length === 0) return false;

	return isIgnoredPath(context, path, residual);
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
	residual: DeclarationTrie | undefined,
): void => {
	const beforeEntries = dataEntryValuesOf(before, ignoreArrayIndexes);
	const afterEntries = dataEntryValuesOf(after, ignoreArrayIndexes);
	const keys = new Set<string>([...beforeEntries.keys(), ...afterEntries.keys()]);

	for (const key of keys) {
		const nextPath = appendOperationPath(path, key);
		const childResidual = declarationChild(residual, key);
		const beforePresent = beforeEntries.has(key);
		const afterPresent = afterEntries.has(key);

		if (beforePresent && afterPresent) {
			diffValue(context, beforeEntries.get(key), afterEntries.get(key), nextPath, childResidual);
		} else if (beforePresent && !Object.hasOwn(after, key)) {
			pushRemoval(context, nextPath, beforeEntries.get(key), childResidual);
		} else if (afterPresent && !Object.hasOwn(before, key)) {
			pushAddition(context, nextPath, afterEntries.get(key), childResidual);
		}
	}
};

const diffArray = (
	context: DiffContext,
	before: Array<unknown>,
	after: Array<unknown>,
	path: OperationPath,
	residual: DeclarationTrie | undefined,
): void => {
	const overlap = Math.min(before.length, after.length);

	for (let index = 0; index < overlap; index++) {
		const beforePresent = Object.hasOwn(before, index);
		const afterPresent = Object.hasOwn(after, index);

		if (!beforePresent && !afterPresent) continue;

		const nextPath = appendOperationPath(path, index);
		const childResidual = declarationChild(residual, index);

		if (!beforePresent) pushAddition(context, nextPath, after[index], childResidual);
		else if (!afterPresent) pushRemoval(context, nextPath, before[index], childResidual);
		else diffValue(context, before[index], after[index], nextPath, childResidual);
	}

	if (after.length > before.length) {
		pushChange(
			context,
			appendOperationPath(path, "length"),
			before.length,
			after.length,
			declarationChild(residual, "length"),
		);

		for (let index = before.length; index < after.length; index++) {
			if (Object.hasOwn(after, index))
				pushAddition(context, appendOperationPath(path, index), after[index], declarationChild(residual, index));
		}
	} else if (after.length < before.length) {
		for (let index = after.length; index < before.length; index++) {
			if (Object.hasOwn(before, index))
				pushRemoval(context, appendOperationPath(path, index), before[index], declarationChild(residual, index));
		}

		pushChange(
			context,
			appendOperationPath(path, "length"),
			before.length,
			after.length,
			declarationChild(residual, "length"),
		);
	}

	diffObjectProperties(context, before, after, path, true, residual);
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

const diffValue = (
	context: DiffContext,
	before: unknown,
	after: unknown,
	path: OperationPath,
	residual: DeclarationTrie | undefined,
): void => {
	const replacing =
		path.length > 0 && isObjectLike(before) && isObjectLike(after) && !sharesStorageIdentity(before, after);

	if (replacing && writesTables(context)) dropOccupancyRoutesUnder(path, context.capture);

	const visit = admitEmitPath(context, path, before, after, isObjectLike(before) || before !== undefined, residual);

	if (visit === "omit") return;

	if (visit === "skip" || isSkippedPath(context, path, residual)) {
		if (isOmittedPath(context, path) || Object.is(before, after)) return;

		if (isObjectLike(before) && isObjectLike(after) && sharesStorageIdentity(before, after)) return;

		if (isIgnoredPath(context, path, residual)) return;

		markChangedPath(context, path);

		pushChange(context, path, before, after, residual);

		return;
	}

	if (Object.is(before, after)) {
		if (writesTables(context)) recordDescendantRoutes(context, path, new Set(), true, residual);

		return;
	}

	if (replacing) {
		markChangedPath(context, path);

		pushChange(context, path, before, after, residual);

		return;
	}

	if (isPlainArray(before) && isPlainArray(after)) {
		walkContainer(context, before, after, path, () => diffArray(context, before, after, path, residual));

		return;
	}

	if (isPlainObject(before) && isPlainObject(after)) {
		walkContainer(context, before, after, path, () =>
			diffObjectProperties(context, before, after, path, false, residual),
		);

		return;
	}

	markChangedPath(context, path);

	pushChange(context, path, before, after, residual);
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

	let index = 0;

	for (const pair of ops) {
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

		index += 1;
	}

	return (route: OperationPath, afterIndex: number): boolean => {
		let current = root;

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
		decomposingRemovals: new Set(),
		beforeRoot: before,
		afterRoot: after,
		linksEnabled,
		handle,
		dirty,
		capture: capture ?? createCaptureTables(),
	};

	diffValue(context, before, after, createOperationPath([]), handle?.declarations);
	rewriteSurvivingUndos(context);

	return ops;
}
