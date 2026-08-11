import { getRegisteredTarget, isSameIdentity } from "../identity";
import { walkDataEntries } from "../utils/dataEntries";
import { isCloneable, isPlainArray, isPlainObject } from "./cloneValue";
import {
	canonicalRouteOf,
	externalRoutesOf,
	resolveCandidates,
	routeUnderPath,
	takeFormationCandidates,
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
	readonly liveRoot: object;
	readonly beforeRoot: object;
	readonly afterRoot: object;
	readonly linksEnabled: boolean;
	candidateRoutes: Map<object, ReadonlyArray<OperationPath>>;
	readonly removalLives: Set<object>;
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

const routesOf = (context: DiffContext, live: object): ReadonlyArray<OperationPath> =>
	context.candidateRoutes.get(live) ?? [];

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
	const routes = routesOf(context, live);
	const external = externalRoutesOf(routes, container).filter((route) =>
		routeResolvesIn(context.afterRoot, route, live),
	);

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

const harvestInteriorCandidates = (context: DiffContext, value: object): void => {
	const lives = new Set<object>();
	const visited = new Set<object>();

	const visit = (node: object): void => {
		const live = liveOf(node);

		if (visited.has(live)) return;

		visited.add(live);

		if (getRegisteredTarget(node) !== undefined) lives.add(live);

		if (!isCloneable(node)) return;

		for (const entry of walkDataEntries(node)) {
			const child: unknown = entry.value;

			if (!isObjectLike(child)) continue;

			visit(child);
		}
	};

	visit(value);

	const missing = new Set<object>();

	for (const live of lives) {
		if (!context.candidateRoutes.has(live)) missing.add(live);
	}

	if (missing.size === 0) return;

	for (const [live, routes] of resolveCandidates(context.liveRoot, missing)) {
		context.candidateRoutes.set(live, routes);
	}
};

const valueHasEmbeddedEscapes = (context: DiffContext, value: unknown, formation: OperationPath): boolean => {
	if (!isObjectLike(value) || !isCloneable(value) || context.candidateRoutes.size === 0) return false;

	const visited = new Set<object>([liveOf(value)]);

	const visit = (node: object): boolean => {
		const live = liveOf(node);

		if (visited.has(live)) return false;

		visited.add(live);

		const routes = context.candidateRoutes.get(live);

		if (routes !== undefined && refForMint(context, live, formation) !== undefined) return true;

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

const mintDecomposedAddition = (context: DiffContext, path: OperationPath, after: object): DiffResult =>
	mergeResults([
		commitOperation(context, context.ops.length, path, additionPair(path, emptyContainerOf(after)), weighCarried),
		mintDecomposedContents(context, path, after),
	]);

const mintDecomposedChange = (context: DiffContext, path: OperationPath, before: unknown, after: object): DiffResult =>
	mergeResults([
		commitOperation(
			context,
			context.ops.length,
			path,
			changePair(path, before, emptyContainerOf(after)),
			weighCarried,
		),
		mintDecomposedContents(context, path, after),
	]);

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

		if (ancestorPath !== undefined && ancestorPath.length > 0)
			return commitLink(context, path, ancestorPath, before, beforePresent);

		const ref = refForMint(context, live, path);

		if (ref !== undefined) return commitLink(context, path, ref, before, beforePresent);

		if (isPlainObject(after) || isPlainArray(after)) {
			if (context.candidateRoutes.has(live)) harvestInteriorCandidates(context, after);

			if (valueHasEmbeddedEscapes(context, after, path)) {
				if (!beforePresent) return mintDecomposedAddition(context, path, after);

				return mintDecomposedChange(context, path, before, after);
			}
		}
	}

	if (beforePresent) {
		return commitOperation(context, context.ops.length, path, changePair(path, before, after), weighCarried);
	}

	return commitOperation(context, context.ops.length, path, additionPair(path, after), weighCarried);
};

const pushAddition = (context: DiffContext, path: OperationPath, after: unknown): DiffResult =>
	mintAssignment(context, path, undefined, after, false);

const pushRemoval = (context: DiffContext, path: OperationPath, before: unknown): DiffResult => {
	if (isObjectLike(before)) context.removalLives.add(liveOf(before));

	return commitOperation(context, context.ops.length, path, removalPair(path, before), weighCarried);
};

const pushChange = (context: DiffContext, path: OperationPath, before: unknown, after: unknown): DiffResult =>
	mintAssignment(context, path, before, after, true);

const resolveRemovalRoutes = (context: DiffContext): void => {
	const missing = new Set<object>();

	for (const live of context.removalLives) {
		if (!context.candidateRoutes.has(live)) missing.add(live);
	}

	if (missing.size === 0) return;

	const resolved = resolveCandidates(context.liveRoot, missing);

	for (const live of missing) context.candidateRoutes.set(live, resolved.get(live) ?? []);
};

const collapseHidesSurvivingRemoval = (context: DiffContext, opsStart: number): boolean => {
	const removals = new Array<{ readonly path: OperationPath; readonly live: object }>();

	for (let index = opsStart; index < context.ops.length; index++) {
		const pair = context.ops[index];

		if (pair?.do.verb !== "delete" || pair.undo.verb !== "assign") continue;

		const original = getValueOriginal(pair.undo);

		if (isObjectLike(original)) removals.push({ path: pair.do.path, live: liveOf(original) });
	}

	if (removals.length === 0) return false;

	resolveRemovalRoutes(context);

	return removals.some((removal) => externalRoutesOf(routesOf(context, removal.live), removal.path).length > 0);
};

const tryCollapse = (
	context: DiffContext,
	before: unknown,
	after: unknown,
	path: OperationPath,
	opsStart: number,
	walked: DiffResult,
): DiffResult => {
	if (walked.weight === 0) return walked;

	if (valueHasEmbeddedEscapes(context, after, path) || valueHasEmbeddedEscapes(context, before, path)) {
		return walked;
	}

	if (context.linksEnabled && collapseHidesSurvivingRemoval(context, opsStart)) return walked;

	const beforeWeight = weighValue(before, walked.weight);
	const afterWeight = weighValue(after, walked.weight - beforeWeight);
	const collapsedWeight = OPERATION_WEIGHT + beforeWeight + afterWeight;

	if (collapsedWeight < walked.weight) {
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
	}

	return walked;
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

const routeDisturbedAfter = (context: DiffContext, index: number, route: OperationPath): boolean => {
	for (let later = index + 1; later < context.ops.length; later++) {
		const pair = context.ops[later];

		if (pair === undefined) continue;

		if (routeUnderPath(route, pair.do.path)) return true;
	}

	return false;
};

const rewriteSurvivingUndos = (context: DiffContext): void => {
	if (!context.linksEnabled) return;

	const lives = new Set<object>();

	for (const live of context.removalLives) {
		if (!context.candidateRoutes.has(live)) lives.add(live);
	}

	for (const pair of context.ops) {
		if (pair.undo.verb !== "assign") continue;

		const original = getValueOriginal(pair.undo);

		if (!isObjectLike(original)) continue;

		const live = liveOf(original);

		if (!context.candidateRoutes.has(live)) lives.add(live);
	}

	if (lives.size > 0) {
		for (const [live, routes] of resolveCandidates(context.liveRoot, lives)) {
			context.candidateRoutes.set(live, routes);
		}
	}

	for (let index = 0; index < context.ops.length; index++) {
		const pair = context.ops[index];

		if (pair === undefined) continue;

		if (pair.undo.verb !== "assign") continue;

		const original = getValueOriginal(pair.undo);

		if (!isObjectLike(original)) continue;

		const live = liveOf(original);
		const external = externalRoutesOf(context.candidateRoutes.get(live) ?? [], pair.do.path);
		const surviving = external.find((route) => !routeDisturbedAfter(context, index, route));

		if (surviving === undefined) continue;

		context.ops[index] = {
			do: pair.do,
			undo: createLinkMutation(pair.do.path, surviving),
		};
	}
};

/**
 * Produces invertible assign/delete pairs for the structural differences between two plain objects or
 * arrays. Neither argument need be a valtio snapshot.
 *
 * Plain-object value diffing with severance: shared structure is not carried as links, each path is
 * independent, and this public surface has no live graph and mints no links. Cycles are ordinary
 * topology: pair re-entry is equality-in-progress, not an error.
 *
 * @param before - Earlier value.
 * @param after - Later value.
 * @returns Operations that take before to after.
 */
export function diffObjects(before: object, after: object): Array<Operation> {
	const beforeKind = getRootKind(before);
	const afterKind = getRootKind(after);

	if (beforeKind === undefined || beforeKind !== afterKind) throw new IncompatibleObjectRootsError();

	const ops = new Array<Operation>();
	const liveRoot = liveOf(after);
	const linksEnabled = getRegisteredTarget(after) !== undefined;
	const candidates = new Set<object>(linksEnabled ? takeFormationCandidates(liveRoot) : []);
	const candidateRoutes = new Map(resolveCandidates(liveRoot, candidates));

	const context: DiffContext = {
		ops,
		ancestors: new Map(),
		ancestorPaths: new Map(),
		liveRoot,
		beforeRoot: before,
		afterRoot: after,
		linksEnabled,
		candidateRoutes,
		removalLives: new Set(),
	};

	diffValue(context, before, after, createOperationPath([]));
	rewriteSurvivingUndos(context);

	return ops;
}
