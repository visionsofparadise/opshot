import { isSameIdentity } from "../identity";
import { carriedOwnKeys, walkDataEntries } from "../utils/dataEntries";
import { cyclicError, isCloneable, isPlainArray, isPlainObject } from "./cloneValue";
import { createAssignMutation, createDeleteMutation, getValueOriginal, type Operation } from "./operation";
import { appendOperationPath, createOperationPath, type OperationPath } from "./path";
import { isCanonicalArrayIndexString, isObjectLike } from "./predicates";
import { OPERATION_WEIGHT, weighValue } from "./weight";

type RootKind = "plainObject" | "plainArray";
type Ancestors = Map<object, Set<object>>;

const UNCAPPED_WEIGHT = Number.MAX_SAFE_INTEGER;

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

const assertAcyclic = (value: unknown, path: OperationPath, black: WeakSet<object>): void => {
	if (!isCloneable(value)) return;

	const grey = new WeakSet<object>();

	const visit = (node: unknown): void => {
		if (!isCloneable(node)) return;

		if (black.has(node)) return;

		if (grey.has(node)) throw cyclicError(path);

		grey.add(node);

		for (const key of carriedOwnKeys(node)) {
			const descriptor = Reflect.getOwnPropertyDescriptor(node, key);

			if (!descriptor || !("value" in descriptor)) continue;

			visit(descriptor.value);
		}

		grey.delete(node);
		black.add(node);
	};

	visit(value);
};

const commitOperation = (
	ops: Array<Operation>,
	opsStart: number,
	path: OperationPath,
	pair: Operation,
	weighHalf: (value: unknown) => number,
	black: WeakSet<object>,
): number => {
	ops.splice(opsStart, ops.length - opsStart, pair);

	if ("value" in pair.do) assertAcyclic(getValueOriginal(pair.do), path, black);

	if (path.length === 1) return 0;

	let weight = OPERATION_WEIGHT;

	if ("value" in pair.do) weight += weighHalf(getValueOriginal(pair.do));

	if ("value" in pair.undo) weight += weighHalf(getValueOriginal(pair.undo));

	return weight;
};

const pushAddition = (ops: Array<Operation>, path: OperationPath, after: unknown, black: WeakSet<object>): number =>
	commitOperation(ops, ops.length, path, additionPair(path, after), weighCarried, black);

const pushRemoval = (ops: Array<Operation>, path: OperationPath, before: unknown, black: WeakSet<object>): number =>
	commitOperation(ops, ops.length, path, removalPair(path, before), weighCarried, black);

const pushChange = (
	ops: Array<Operation>,
	path: OperationPath,
	before: unknown,
	after: unknown,
	black: WeakSet<object>,
): number => commitOperation(ops, ops.length, path, changePair(path, before, after), weighCarried, black);

const tryCollapse = (
	before: unknown,
	after: unknown,
	path: OperationPath,
	ops: Array<Operation>,
	opsStart: number,
	atomicWeight: number,
	black: WeakSet<object>,
): number => {
	if (atomicWeight === 0) return 0;

	const beforeWeight = weighValue(before, atomicWeight);
	const afterWeight = weighValue(after, atomicWeight - beforeWeight);
	const collapsedWeight = OPERATION_WEIGHT + beforeWeight + afterWeight;

	if (collapsedWeight < atomicWeight) {
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

		return commitOperation(ops, opsStart, path, changePair(path, before, after), weighHalf, black);
	}

	return atomicWeight;
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

const dataEntryValues = (value: object): Map<string, unknown> => {
	const entries = new Map<string, unknown>();

	for (const entry of walkDataEntries(value)) entries.set(entry.key, entry.value);

	return entries;
};

const diffObjectProperties = (
	before: Record<string, unknown> | Array<unknown>,
	after: Record<string, unknown> | Array<unknown>,
	path: OperationPath,
	ops: Array<Operation>,
	ancestors: Ancestors,
	ignoreArrayIndexes: boolean,
	black: WeakSet<object>,
): number => {
	let weight = 0;
	const beforeEntries = dataEntryValues(before);
	const afterEntries = dataEntryValues(after);
	const keys = new Set<string>([...beforeEntries.keys(), ...afterEntries.keys()]);

	for (const key of keys) {
		if (ignoreArrayIndexes && isCanonicalArrayIndexString(key)) continue;

		const nextPath = appendOperationPath(path, key);
		const beforePresent = beforeEntries.has(key);
		const afterPresent = afterEntries.has(key);

		if (beforePresent && afterPresent) {
			weight += diffValue(beforeEntries.get(key), afterEntries.get(key), nextPath, ops, ancestors, black);
		} else if (beforePresent && !Object.hasOwn(after, key)) {
			weight += pushRemoval(ops, nextPath, beforeEntries.get(key), black);
		} else if (afterPresent && !Object.hasOwn(before, key)) {
			weight += pushAddition(ops, nextPath, afterEntries.get(key), black);
		}
	}

	return weight;
};

const diffArray = (
	before: Array<unknown>,
	after: Array<unknown>,
	path: OperationPath,
	ops: Array<Operation>,
	ancestors: Ancestors,
	black: WeakSet<object>,
): number => {
	const overlap = Math.min(before.length, after.length);
	let weight = 0;

	for (let index = 0; index < overlap; index++) {
		const beforePresent = Object.hasOwn(before, index);
		const afterPresent = Object.hasOwn(after, index);

		if (!beforePresent && !afterPresent) continue;

		const nextPath = appendOperationPath(path, index);

		if (!beforePresent) weight += pushAddition(ops, nextPath, after[index], black);
		else if (!afterPresent) weight += pushRemoval(ops, nextPath, before[index], black);
		else weight += diffValue(before[index], after[index], nextPath, ops, ancestors, black);
	}

	if (after.length > before.length) {
		weight += pushChange(ops, appendOperationPath(path, "length"), before.length, after.length, black);

		for (let index = before.length; index < after.length; index++) {
			if (Object.hasOwn(after, index))
				weight += pushAddition(ops, appendOperationPath(path, index), after[index], black);
		}
	} else if (after.length < before.length) {
		for (let index = after.length; index < before.length; index++) {
			if (Object.hasOwn(before, index))
				weight += pushRemoval(ops, appendOperationPath(path, index), before[index], black);
		}

		weight += pushChange(ops, appendOperationPath(path, "length"), before.length, after.length, black);
	}

	weight += diffObjectProperties(before, after, path, ops, ancestors, true, black);

	return weight;
};

const walkContainer = (
	before: object,
	after: object,
	path: OperationPath,
	ops: Array<Operation>,
	ancestors: Ancestors,
	black: WeakSet<object>,
	walk: () => number,
): number => {
	if (hasAncestorPair(ancestors, before, after)) throw cyclicError(path);

	enterAncestorPair(ancestors, before, after);

	try {
		if (path.length === 0) {
			walk();

			return 0;
		}

		const opsStart = ops.length;
		const atomicWeight = walk();

		return tryCollapse(before, after, path, ops, opsStart, atomicWeight, black);
	} finally {
		exitAncestorPair(ancestors, before, after);
	}
};

const diffValue = (
	before: unknown,
	after: unknown,
	path: OperationPath,
	ops: Array<Operation>,
	ancestors: Ancestors,
	black: WeakSet<object>,
): number => {
	if (Object.is(before, after)) return 0;

	if (path.length > 0 && isObjectLike(before) && isObjectLike(after) && !sharesStorageIdentity(before, after)) {
		return pushChange(ops, path, before, after, black);
	}

	if (isPlainArray(before) && isPlainArray(after)) {
		return walkContainer(before, after, path, ops, ancestors, black, () =>
			diffArray(before, after, path, ops, ancestors, black),
		);
	}

	if (isPlainObject(before) && isPlainObject(after)) {
		return walkContainer(before, after, path, ops, ancestors, black, () =>
			diffObjectProperties(before, after, path, ops, ancestors, false, black),
		);
	}

	return pushChange(ops, path, before, after, black);
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
 * @param before - Earlier value.
 * @param after - Later value.
 * @returns Operations that take before to after.
 */
export function diffObjects(before: object, after: object): Array<Operation> {
	const beforeKind = getRootKind(before);
	const afterKind = getRootKind(after);

	if (beforeKind === undefined || beforeKind !== afterKind) throw new IncompatibleObjectRootsError();

	const ops = new Array<Operation>();

	diffValue(before, after, createOperationPath([]), ops, new Map(), new WeakSet());

	return ops;
}
