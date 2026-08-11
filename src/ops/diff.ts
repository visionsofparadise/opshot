import { getRegisteredTarget, isSameIdentity } from "../identity";
import { parentsOf, reachesNode } from "../inEdges";
import { carriedOwnKeysOf, walkDataEntries } from "../utils/dataEntries";
import { isCloneable, isPlainArray, isPlainObject } from "./cloneValue";
import { createAssignMutation, createDeleteMutation, getValueOriginal, type Operation } from "./operation";
import { appendOperationPath, createOperationPath, type OperationPath } from "./path";
import { isCanonicalArrayIndexString, isObjectLike } from "./predicates";
import { OPERATION_WEIGHT, weighValue } from "./weight";

type RootKind = "plainObject" | "plainArray";
type Ancestors = Map<object, Set<object>>;

const UNCAPPED_WEIGHT = Number.MAX_SAFE_INTEGER;

interface EscapeGroup {
	readonly pair: Operation;
	readonly parents: Set<object>;
}

interface DiffResult {
	readonly weight: number;
	readonly groups: Array<EscapeGroup>;
}

interface DiffContext {
	readonly ops: Array<Operation>;
	readonly ancestors: Ancestors;
	readonly beforeRoot: object;
	readonly afterRoot: object;
	readonly diffRootLive: object;
	readonly climbMemo: Map<object, Map<object, boolean>>;
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

const emptyResult = (): DiffResult => ({ weight: 0, groups: [] });

const mergeResults = (results: ReadonlyArray<DiffResult>): DiffResult => {
	let weight = 0;
	const groups = new Array<EscapeGroup>();

	for (const result of results) {
		weight += result.weight;
		groups.push(...result.groups);
	}

	return { weight, groups };
};

const liveOf = (node: object): object => getRegisteredTarget(node) ?? node;

const resolveLiveAtPath = (root: object, path: OperationPath): object | undefined => {
	let current: unknown = root;

	for (const segment of path) {
		if (!isObjectLike(current)) return undefined;

		current = Reflect.get(current, segment);
	}

	if (!isObjectLike(current)) return undefined;

	return liveOf(current);
};

const edgeKeyEquals = (tableKey: string | number, pathSegment: unknown): boolean =>
	tableKey === pathSegment || String(tableKey) === String(pathSegment);

const collectEscapes = (
	value: unknown,
	opPath: OperationPath,
	context: DiffContext,
	excludeOwnAddress: boolean,
): Set<object> => {
	const escapes = new Set<object>();

	if (!isCloneable(value)) return escapes;

	const visited = new Set<object>();
	const liveVisited = new Set<object>();
	const carriedRootLive = liveOf(value);

	const visit = (node: unknown): void => {
		if (!isCloneable(node)) return;

		if (visited.has(node)) return;

		visited.add(node);
		liveVisited.add(liveOf(node));

		for (const key of carriedOwnKeysOf(node)) {
			const descriptor = Reflect.getOwnPropertyDescriptor(node, key);

			if (!descriptor || !("value" in descriptor)) continue;

			visit(descriptor.value);
		}
	};

	visit(value);

	const addressParent =
		excludeOwnAddress && opPath.length > 0
			? opPath.length === 1
				? liveOf(context.afterRoot)
				: resolveLiveAtPath(context.afterRoot, createOperationPath(opPath.slice(0, -1)))
			: undefined;
	const addressKey = excludeOwnAddress && opPath.length > 0 ? opPath[opPath.length - 1] : undefined;

	const isOutsideCarried = (parent: object): boolean => {
		if (liveVisited.has(parent)) return false;

		if (reachesNode(parent, carriedRootLive, context.climbMemo)) return false;

		return true;
	};

	for (const live of liveVisited) {
		const parents = parentsOf(live);

		if (parents === undefined) continue;

		for (const [parent, keys] of parents) {
			if (
				addressParent !== undefined &&
				addressKey !== undefined &&
				live === carriedRootLive &&
				parent === addressParent
			) {
				let remainingKeys = 0;

				for (const key of keys) {
					if (!edgeKeyEquals(key, addressKey)) remainingKeys += 1;
				}

				if (remainingKeys === 0) continue;
			}

			if (!isOutsideCarried(parent)) continue;

			if (!reachesNode(parent, context.diffRootLive, context.climbMemo)) continue;

			escapes.add(parent);
		}
	}

	return escapes;
};

const commitOperation = (
	context: DiffContext,
	opsStart: number,
	path: OperationPath,
	pair: Operation,
	weighHalf: (value: unknown) => number,
): DiffResult => {
	context.ops.splice(opsStart, context.ops.length - opsStart, pair);

	const escapes = new Set<object>();

	if ("value" in pair.do) {
		for (const parent of collectEscapes(getValueOriginal(pair.do), path, context, true)) escapes.add(parent);
	}

	if ("value" in pair.undo) {
		for (const parent of collectEscapes(getValueOriginal(pair.undo), path, context, true)) escapes.add(parent);
	}

	const groups = escapes.size > 0 ? [{ pair, parents: escapes } satisfies EscapeGroup] : new Array<EscapeGroup>();

	if (path.length <= 1) return { weight: 0, groups };

	let weight = OPERATION_WEIGHT;

	if ("value" in pair.do) weight += weighHalf(getValueOriginal(pair.do));

	if ("value" in pair.undo) weight += weighHalf(getValueOriginal(pair.undo));

	return { weight, groups };
};

const pushAddition = (context: DiffContext, path: OperationPath, after: unknown): DiffResult =>
	commitOperation(context, context.ops.length, path, additionPair(path, after), weighCarried);

const pushRemoval = (context: DiffContext, path: OperationPath, before: unknown): DiffResult =>
	commitOperation(context, context.ops.length, path, removalPair(path, before), weighCarried);

const pushChange = (context: DiffContext, path: OperationPath, before: unknown, after: unknown): DiffResult =>
	commitOperation(context, context.ops.length, path, changePair(path, before, after), weighCarried);

const tryCollapse = (
	context: DiffContext,
	before: unknown,
	after: unknown,
	path: OperationPath,
	opsStart: number,
	walked: DiffResult,
): { readonly result: DiffResult; readonly collapsed: boolean } => {
	if (walked.weight === 0) return { result: walked, collapsed: false };

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

		return {
			result: commitOperation(context, opsStart, path, changePair(path, before, after), weighHalf),
			collapsed: true,
		};
	}

	return { result: walked, collapsed: false };
};

const frameAddressParent = (context: DiffContext, path: OperationPath): object | undefined => {
	if (path.length === 0) return undefined;

	if (path.length === 1) return liveOf(context.afterRoot);

	return resolveLiveAtPath(context.afterRoot, createOperationPath(path.slice(0, -1)));
};

const parentContainedByFrame = (
	parent: object,
	frameLive: object,
	addressParent: object | undefined,
	context: DiffContext,
): boolean => {
	if (parent === frameLive) return true;

	if (addressParent !== undefined && parent === addressParent) return true;

	return reachesNode(parent, frameLive, context.climbMemo);
};

const processFrameExit = (
	context: DiffContext,
	before: object,
	after: object,
	path: OperationPath,
	opsStart: number,
	walked: DiffResult,
	collapsed: boolean,
): DiffResult => {
	if (collapsed) return walked;

	const frameLive = liveOf(after);
	const addressParent = frameAddressParent(context, path);
	const openGroups = new Array<EscapeGroup>();
	let forceWholesale = false;

	for (const group of walked.groups) {
		const remaining = new Set<object>();

		for (const parent of group.parents) {
			if (!parentContainedByFrame(parent, frameLive, addressParent, context)) remaining.add(parent);
		}

		if (remaining.size === 0) {
			forceWholesale = true;

			break;
		}

		openGroups.push({ pair: group.pair, parents: remaining });
	}

	if (!forceWholesale) return { weight: walked.weight, groups: openGroups };

	return commitOperation(context, opsStart, path, changePair(path, before, after), weighCarried);
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

	try {
		const opsStart = context.ops.length;
		const walked = walk();

		if (path.length === 0) return processFrameExit(context, before, after, path, opsStart, walked, false);

		const { result: collapsed, collapsed: economicallyCollapsed } = tryCollapse(
			context,
			before,
			after,
			path,
			opsStart,
			walked,
		);

		return processFrameExit(context, before, after, path, opsStart, collapsed, economicallyCollapsed);
	} finally {
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

/**
 * Produces invertible assign/delete pairs for the structural differences between two plain objects or arrays.
 * Neither argument need be a valtio snapshot.
 *
 * Cycles and aliases are ordinary topology: pair re-entry is equality-in-progress, not an error.
 * An interior change reachable by k routes mints k ops, one per simple route. When a carried value
 * would hold an edge escaping the carried subtree, the mint surfaces to **closure** — the minimal
 * ancestor that contains every such target — so both halves close. Groups still open after the
 * root descent mint the root op (`assign` at `[]`, rendered as `"/"`). No cycle throws.
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
	const context: DiffContext = {
		ops,
		ancestors: new Map(),
		beforeRoot: before,
		afterRoot: after,
		diffRootLive: liveOf(after),
		climbMemo: new Map(),
	};

	const result = diffValue(context, before, after, createOperationPath([]));

	if (result.groups.length > 0) {
		commitOperation(
			context,
			0,
			createOperationPath([]),
			changePair(createOperationPath([]), before, after),
			weighCarried,
		);
	}

	return ops;
}
