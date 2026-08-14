import { getRegisteredTarget, isSameIdentity } from "../identity";
import { walkDataEntries } from "../utils/dataEntries";
import { isCloneable, isPlainArray, isPlainObject } from "./cloneValue";
import {
	canonicalRouteOf,
	createRouteIndex,
	externalRoutesOf,
	isPossiblyShared,
	routeUnderPath,
	type RouteIndex,
} from "./commitWalk";
import {
	createAssignMutation,
	createDeleteMutation,
	createLinkMutation,
	getValueOriginal,
	type Operation,
} from "./operation";
import { appendOperationPath, createOperationPath, type OperationPath } from "./path";
import { isCanonicalArrayIndexString, isObjectLike } from "./predicates";
import { OPERATION_WEIGHT, weighValue } from "./weight";

type RootKind = "plainObject" | "plainArray";
type Ancestors = Map<object, Set<object>>;

const UNCAPPED_WEIGHT = Number.MAX_SAFE_INTEGER;

interface DiffResult {
	readonly weight: number;
}

interface DiffContext {
	readonly ops: Array<Operation>;
	readonly ancestors: Ancestors;
	readonly ancestorPaths: Map<object, OperationPath>;
	readonly firstMintRoute: Map<object, OperationPath>;
	readonly liveRoot: object;
	readonly beforeRoot: object;
	readonly afterRoot: object;
	readonly linksEnabled: boolean;
	routeIndex: RouteIndex | undefined;
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

const weighCarried = (value: unknown): number => weighValue(value, UNCAPPED_WEIGHT);

const emptyResult = (): DiffResult => ({ weight: 0 });

const mergeResults = (results: ReadonlyArray<DiffResult>): DiffResult => {
	let weight = 0;

	for (const result of results) weight += result.weight;

	return { weight };
};

const liveOf = (node: object): object => getRegisteredTarget(node) ?? node;

const requireRouteIndex = (context: DiffContext): RouteIndex => {
	context.routeIndex ??= createRouteIndex(context.liveRoot);

	return context.routeIndex;
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
): ReadonlyArray<OperationPath> => usableRoutesIn(context, requireRouteIndex(context).routesOf(live), live, formation);

const routeResolvesIn = (root: object, route: OperationPath, live: object): boolean => {
	let current: unknown = root;

	for (const segment of route) {
		if (!isObjectLike(current)) return false;

		const container = current as Record<string | number, unknown>;

		if (!Object.hasOwn(container, segment)) return false;

		current = container[segment];
	}

	return isObjectLike(current) && liveOf(current) === live;
};

const refForMint = (context: DiffContext, live: object, container: OperationPath): OperationPath | undefined => {
	const routes = requireRouteIndex(context).routesOf(live);
	const external = usableRoutesIn(context, routes, live, container);

	if (external.length === 0) return undefined;

	const predating = external.find((route) => routeResolvesIn(context.beforeRoot, route, live));

	if (predating !== undefined) return predating;

	const canonical = canonicalRouteOf(routes);

	if (canonical !== undefined && routeUnderPath(canonical, container)) return undefined;

	return external[0];
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

const payloadEmbedsEscape = (context: DiffContext, value: object, formation: OperationPath): boolean => {
	const visited = new Set<object>();

	const visit = (node: object): boolean => {
		const live = liveOf(node);

		if (visited.has(live)) return false;

		visited.add(live);

		if (isPossiblyShared(live) && usableExternalRoutesOf(context, live, formation).length > 0) return true;

		if (!isCloneable(node)) return false;

		for (const entry of walkDataEntries(node)) {
			const child: unknown = entry.value;

			if (!isObjectLike(child)) continue;

			if (visit(child)) return true;
		}

		return false;
	};

	for (const entry of walkDataEntries(value)) {
		const child: unknown = entry.value;

		if (!isObjectLike(child)) continue;

		if (visit(child)) return true;
	}

	return false;
};

const payloadHasInteriorSharing = (value: object): boolean => {
	const seen = new Set<object>();

	seen.add(liveOf(value));

	const visit = (node: object): boolean => {
		for (const entry of walkDataEntries(node)) {
			const child: unknown = entry.value;

			if (!isObjectLike(child)) continue;

			const live = liveOf(child);

			if (seen.has(live)) return true;

			seen.add(live);

			if (visit(child)) return true;
		}

		return false;
	};

	return visit(value);
};

const hasSharedEscapeUnderPath = (context: DiffContext, path: OperationPath): boolean => {
	const index = requireRouteIndex(context);

	for (const live of index.sharedLives) {
		const routes = index.routesOf(live);

		if (!routes.some((route) => routeUnderPath(route, path))) continue;

		if (usableRoutesIn(context, routes, live, path).length > 0) return true;
	}

	return false;
};

const carriedUndoLiveOf = (pair: Operation): object | undefined => {
	if (pair.undo.verb !== "assign") return undefined;

	const original = getValueOriginal(pair.undo);

	if (!isObjectLike(original)) return undefined;

	return liveOf(original);
};

const forEachHintedCarriedUndo = (
	context: DiffContext,
	opsStart: number,
	visit: (pair: Operation, live: object, index: number) => boolean,
): void => {
	for (let index = opsStart; index < context.ops.length; index++) {
		const pair = context.ops[index];

		if (pair === undefined) continue;

		const live = carriedUndoLiveOf(pair);

		if (live === undefined || !isPossiblyShared(live)) continue;

		if (visit(pair, live, index)) return;
	}
};

const collapseHidesSurvivingSharing = (context: DiffContext, opsStart: number): boolean => {
	let found = false;

	forEachHintedCarriedUndo(context, opsStart, (pair, live) => {
		if (usableExternalRoutesOf(context, live, pair.do.path).length === 0) return false;

		found = true;

		return true;
	});

	return found;
};

const commitOperation = (
	context: DiffContext,
	opsStart: number,
	path: OperationPath,
	pair: Operation,
	weighHalf: (value: unknown) => number,
): DiffResult => {
	context.ops.splice(opsStart, context.ops.length - opsStart, pair);

	if (path.length <= 1) return { weight: 0 };

	if (pair.do.verb === "link") return { weight: OPERATION_WEIGHT };

	let weight = OPERATION_WEIGHT;

	if ("value" in pair.do) weight += weighHalf(getValueOriginal(pair.do));

	if ("value" in pair.undo) weight += weighHalf(getValueOriginal(pair.undo));

	return { weight };
};

const samePathSegments = (left: OperationPath, right: OperationPath): boolean => {
	if (left.length !== right.length) return false;

	for (let index = 0; index < left.length; index++) {
		if (left[index] !== right[index]) return false;
	}

	return true;
};

const insertOperation = (context: DiffContext, index: number, pair: Operation): DiffResult => {
	context.ops.splice(index, 0, pair);

	return { weight: OPERATION_WEIGHT };
};

const commitLink = (
	context: DiffContext,
	path: OperationPath,
	ref: OperationPath,
	before: unknown,
	beforePresent: boolean,
): DiffResult =>
	commitOperation(context, context.ops.length, path, linkOperation(path, ref, before, beforePresent), weighCarried);

const emptyContainerOf = (value: object): object => (isPlainArray(value) ? [] : {});

const mintDecomposedContents = (context: DiffContext, path: OperationPath, after: object): DiffResult => {
	const results = new Array<DiffResult>();

	if (isPlainArray(after)) {
		if (after.length > 0)
			results.push(
				commitOperation(
					context,
					context.ops.length,
					appendOperationPath(path, "length"),
					changePair(appendOperationPath(path, "length"), 0, after.length),
					weighCarried,
				),
			);

		for (let index = 0; index < after.length; index++) {
			if (!Object.hasOwn(after, index)) continue;

			results.push(pushAddition(context, appendOperationPath(path, index), after[index]));
		}

		results.push(diffObjectProperties(context, [], after, path, true));
	} else {
		for (const entry of walkDataEntries(after)) {
			results.push(pushAddition(context, appendOperationPath(path, entry.key), entry.value));
		}
	}

	return mergeResults(results);
};

const recordFirstMint = (context: DiffContext, live: object, path: OperationPath): OperationPath => {
	const recorded = context.firstMintRoute.get(live);

	if (recorded !== undefined) return recorded;

	context.firstMintRoute.set(live, path);

	return path;
};

const mintDecomposedAddition = (context: DiffContext, path: OperationPath, after: object): DiffResult =>
	mergeResults([
		commitOperation(
			context,
			context.ops.length,
			path,
			{
				do: createAssignMutation(path, emptyContainerOf(after), after),
				undo: createDeleteMutation(path),
			},
			weighCarried,
		),
		mintDecomposedContents(context, path, after),
	]);

const mintDecomposedRemoval = (context: DiffContext, path: OperationPath, before: object): DiffResult => {
	recordFirstMint(context, liveOf(before), path);

	const results = new Array<DiffResult>();

	if (isPlainArray(before)) {
		for (let index = 0; index < before.length; index++) {
			if (!Object.hasOwn(before, index)) continue;

			results.push(pushRemoval(context, appendOperationPath(path, index), before[index]));
		}

		results.push(diffObjectProperties(context, before, [], path, true));
	} else {
		for (const entry of walkDataEntries(before)) {
			results.push(pushRemoval(context, appendOperationPath(path, entry.key), entry.value));
		}
	}

	results.push(
		commitOperation(
			context,
			context.ops.length,
			path,
			{
				do: createDeleteMutation(path),
				undo: createAssignMutation(path, emptyContainerOf(before), before),
			},
			weighCarried,
		),
	);

	return mergeResults(results);
};

const mintDecomposedChange = (context: DiffContext, path: OperationPath, before: unknown, after: object): DiffResult => {
	if (
		isObjectLike(before) &&
		payloadHasInteriorSharing(before) &&
		usableExternalRoutesOf(context, liveOf(before), path).length === 0
	) {
		return mergeResults([mintDecomposedRemoval(context, path, before), mintDecomposedAddition(context, path, after)]);
	}

	return mergeResults([
		commitOperation(
			context,
			context.ops.length,
			path,
			{
				do: createAssignMutation(path, emptyContainerOf(after), after),
				undo: createAssignMutation(path, before),
			},
			weighCarried,
		),
		mintDecomposedContents(context, path, after),
	]);
};

const mintAssignment = (
	context: DiffContext,
	path: OperationPath,
	before: unknown,
	after: unknown,
	beforePresent: boolean,
): DiffResult => {
	if (isObjectLike(after) && context.linksEnabled) {
		const live = liveOf(after);
		const ancestorPath = context.ancestorPaths.get(live);

		if (ancestorPath !== undefined) return commitLink(context, path, ancestorPath, before, beforePresent);

		const recorded = context.firstMintRoute.get(live);

		if (recorded !== undefined && routeResolvesIn(context.afterRoot, recorded, live)) {
			return commitLink(context, path, recorded, before, beforePresent);
		}

		if (isPossiblyShared(live)) {
			const ref = refForMint(context, live, path);

			if (ref !== undefined) return commitLink(context, path, ref, before, beforePresent);
		}

		if (
			(isPlainObject(after) || isPlainArray(after)) &&
			(payloadEmbedsEscape(context, after, path) || payloadHasInteriorSharing(after))
		) {
			recordFirstMint(context, live, path);

			if (!beforePresent) return mintDecomposedAddition(context, path, after);

			return mintDecomposedChange(context, path, before, after);
		}

		recordFirstMint(context, live, path);
	}

	if (beforePresent) {
		return commitOperation(context, context.ops.length, path, changePair(path, before, after), weighCarried);
	}

	return commitOperation(context, context.ops.length, path, additionPair(path, after), weighCarried);
};

const pushAddition = (context: DiffContext, path: OperationPath, after: unknown): DiffResult =>
	mintAssignment(context, path, undefined, after, false);

const pushRemoval = (context: DiffContext, path: OperationPath, before: unknown): DiffResult => {
	if (isObjectLike(before) && context.linksEnabled) {
		const live = liveOf(before);
		const recorded = context.firstMintRoute.get(live);

		if (recorded !== undefined && !samePathSegments(recorded, path)) {
			const pair: Operation = {
				do: createDeleteMutation(path),
				undo: createLinkMutation(path, recorded),
			};
			let insertAt = context.ops.length;

			for (let index = 0; index < context.ops.length; index++) {
				const existing = context.ops[index];

				if (existing === undefined) continue;

				if (existing.do.verb === "delete" && samePathSegments(existing.do.path, recorded)) {
					insertAt = index;

					break;
				}
			}

			return insertOperation(context, insertAt, pair);
		}

		if (payloadHasInteriorSharing(before) && usableExternalRoutesOf(context, live, path).length === 0) {
			return mintDecomposedRemoval(context, path, before);
		}

		recordFirstMint(context, live, path);
	}

	return commitOperation(context, context.ops.length, path, removalPair(path, before), weighCarried);
};

const pushChange = (context: DiffContext, path: OperationPath, before: unknown, after: unknown): DiffResult =>
	mintAssignment(context, path, before, after, true);

const tryCollapse = (
	context: DiffContext,
	before: unknown,
	after: unknown,
	path: OperationPath,
	opsStart: number,
	walked: DiffResult,
): DiffResult => {
	if (walked.weight === 0) return walked;

	const probe = { sawHintedNode: false };
	const onNode = (node: object): void => {
		if (isPossiblyShared(node) || isPossiblyShared(liveOf(node))) probe.sawHintedNode = true;
	};

	const beforeWeight = weighValue(before, walked.weight, onNode);
	const afterWeight = weighValue(after, walked.weight - beforeWeight, onNode);
	const collapsedWeight = OPERATION_WEIGHT + beforeWeight + afterWeight;

	if (collapsedWeight >= walked.weight) return walked;

	if (context.linksEnabled) {
		if (
			(isObjectLike(after) && payloadHasInteriorSharing(after)) ||
			(isObjectLike(before) && payloadHasInteriorSharing(before))
		) {
			return walked;
		}

		if (probe.sawHintedNode && hasSharedEscapeUnderPath(context, path)) return walked;

		if (collapseHidesSurvivingSharing(context, opsStart)) return walked;
	}

	const decisionWeights = new Map<object, number>();

	if (isObjectLike(before)) decisionWeights.set(before, beforeWeight);

	if (isObjectLike(after)) decisionWeights.set(after, afterWeight);

	const weighHalf = (value: unknown): number => {
		if (isObjectLike(value)) {
			const memoized = decisionWeights.get(value);

			if (memoized !== undefined) return memoized;
		}

		return weighCarried(value);
	};

	return commitOperation(context, opsStart, path, changePair(path, before, after), weighHalf);
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
): DiffResult => {
	const results = new Array<DiffResult>();
	const beforeEntries = dataEntryValuesOf(before, ignoreArrayIndexes);
	const afterEntries = dataEntryValuesOf(after, ignoreArrayIndexes);
	const keys = new Set<string>([...beforeEntries.keys(), ...afterEntries.keys()]);

	for (const key of keys) {
		const nextPath = appendOperationPath(path, key);
		const beforePresent = beforeEntries.has(key);
		const afterPresent = afterEntries.has(key);

		if (beforePresent && afterPresent) {
			results.push(diffValue(context, beforeEntries.get(key), afterEntries.get(key), nextPath));
		} else if (beforePresent && !Object.hasOwn(after, key)) {
			results.push(pushRemoval(context, nextPath, beforeEntries.get(key)));
		} else if (afterPresent && !Object.hasOwn(before, key)) {
			results.push(pushAddition(context, nextPath, afterEntries.get(key)));
		}
	}

	return mergeResults(results);
};

const diffArray = (
	context: DiffContext,
	before: Array<unknown>,
	after: Array<unknown>,
	path: OperationPath,
): DiffResult => {
	const results = new Array<DiffResult>();
	const overlap = Math.min(before.length, after.length);

	for (let index = 0; index < overlap; index++) {
		const beforePresent = Object.hasOwn(before, index);
		const afterPresent = Object.hasOwn(after, index);

		if (!beforePresent && !afterPresent) continue;

		const nextPath = appendOperationPath(path, index);

		if (!beforePresent) results.push(pushAddition(context, nextPath, after[index]));
		else if (!afterPresent) results.push(pushRemoval(context, nextPath, before[index]));
		else results.push(diffValue(context, before[index], after[index], nextPath));
	}

	if (after.length > before.length) {
		results.push(pushChange(context, appendOperationPath(path, "length"), before.length, after.length));

		for (let index = before.length; index < after.length; index++) {
			if (Object.hasOwn(after, index))
				results.push(pushAddition(context, appendOperationPath(path, index), after[index]));
		}
	} else if (after.length < before.length) {
		for (let index = after.length; index < before.length; index++) {
			if (Object.hasOwn(before, index))
				results.push(pushRemoval(context, appendOperationPath(path, index), before[index]));
		}

		results.push(pushChange(context, appendOperationPath(path, "length"), before.length, after.length));
	}

	results.push(diffObjectProperties(context, before, after, path, true));

	return mergeResults(results);
};

const walkContainer = (
	context: DiffContext,
	before: object,
	after: object,
	path: OperationPath,
	walk: () => DiffResult,
): DiffResult => {
	if (hasAncestorPair(context.ancestors, before, after)) return emptyResult();

	enterAncestorPair(context.ancestors, before, after);

	const afterLive = liveOf(after);
	const priorPath = context.ancestorPaths.get(afterLive);

	if (priorPath === undefined) context.ancestorPaths.set(afterLive, path);

	try {
		const opsStart = context.ops.length;
		const walked = walk();

		if (path.length === 0) return walked;

		return tryCollapse(context, before, after, path, opsStart, walked);
	} finally {
		if (priorPath === undefined) context.ancestorPaths.delete(afterLive);

		exitAncestorPair(context.ancestors, before, after);
	}
};

const diffValue = (context: DiffContext, before: unknown, after: unknown, path: OperationPath): DiffResult => {
	if (Object.is(before, after)) return emptyResult();

	if (path.length > 0 && isObjectLike(before) && isObjectLike(after) && !sharesStorageIdentity(before, after)) {
		return pushChange(context, path, before, after);
	}

	if (isPlainArray(before) && isPlainArray(after)) {
		return walkContainer(context, before, after, path, () => diffArray(context, before, after, path));
	}

	if (isPlainObject(before) && isPlainObject(after)) {
		return walkContainer(context, before, after, path, () =>
			diffObjectProperties(context, before, after, path, false),
		);
	}

	return pushChange(context, path, before, after);
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

	forEachHintedCarriedUndo(context, 0, (pair, live, index) => {
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
export function diffObjects(before: object, after: object): Array<Operation> {
	const beforeKind = getRootKind(before);
	const afterKind = getRootKind(after);

	if (beforeKind === undefined || beforeKind !== afterKind) throw new IncompatibleObjectRootsError();

	const ops = new Array<Operation>();
	const liveRoot = liveOf(after);
	const linksEnabled = getRegisteredTarget(after) !== undefined;

	const context: DiffContext = {
		ops,
		ancestors: new Map(),
		ancestorPaths: new Map(),
		firstMintRoute: new Map(),
		liveRoot,
		beforeRoot: before,
		afterRoot: after,
		linksEnabled,
		routeIndex: undefined,
	};

	diffValue(context, before, after, createOperationPath([]));
	rewriteSurvivingUndos(context);

	return ops;
}
