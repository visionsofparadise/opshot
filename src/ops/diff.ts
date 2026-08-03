import { isSameIdentity } from "../identity";
import { cyclicError, isCloneable, isPlainArray, isPlainObject } from "./cloneValue";
import { createAssignOperation, createDeleteOperation, type Op } from "./operation";
import { appendOperationPath, createOperationPath, type OperationPath } from "./path";
import { OPERATION_WEIGHT, weighValue } from "./weight";

type RootKind = "plainObject" | "plainArray";
type Ancestors = Map<object, Set<object>>;

const UNCAPPED_WEIGHT = Number.MAX_SAFE_INTEGER;

class IncompatibleSnapshotRootsError extends Error {
	constructor() {
		super("opshot: diffSnapshots requires compatible supported object roots");
		this.name = "IncompatibleSnapshotRootsError";
	}
}

const additionPair = (path: OperationPath, after: unknown): Op => ({
	do: createAssignOperation(path, after),
	undo: createDeleteOperation(path),
});

const removalPair = (path: OperationPath, before: unknown): Op => ({
	do: createDeleteOperation(path),
	undo: createAssignOperation(path, before),
});

const changePair = (path: OperationPath, before: unknown, after: unknown): Op => ({
	do: createAssignOperation(path, after),
	undo: createAssignOperation(path, before),
});

const weighCarried = (value: unknown): number => weighValue(value, UNCAPPED_WEIGHT);

const assertAcyclic = (value: unknown, path: OperationPath): void => {
	if (!isCloneable(value)) return;

	const grey = new WeakSet<object>();
	const black = new WeakSet<object>();

	const visit = (node: unknown): void => {
		if (!isCloneable(node)) return;

		if (black.has(node)) return;

		if (grey.has(node)) throw cyclicError(path);

		grey.add(node);

		for (const key of Reflect.ownKeys(node)) {
			if (key === "__proto__") continue;

			const descriptor = Reflect.getOwnPropertyDescriptor(node, key);

			if (!descriptor || !("value" in descriptor)) continue;

			visit(descriptor.value);
		}

		grey.delete(node);
		black.add(node);
	};

	visit(value);
};

const pushAddition = (ops: Array<Op>, path: OperationPath, after: unknown): number => {
	assertAcyclic(after, path);

	ops.push(additionPair(path, after));

	return OPERATION_WEIGHT + weighCarried(after);
};

const pushRemoval = (ops: Array<Op>, path: OperationPath, before: unknown): number => {
	ops.push(removalPair(path, before));

	return OPERATION_WEIGHT + weighCarried(before);
};

const pushChange = (ops: Array<Op>, path: OperationPath, before: unknown, after: unknown): number => {
	assertAcyclic(after, path);

	ops.push(changePair(path, before, after));

	return OPERATION_WEIGHT + weighCarried(before) + weighCarried(after);
};

const tryCollapse = (
	before: unknown,
	after: unknown,
	path: OperationPath,
	ops: Array<Op>,
	opsStart: number,
	atomicWeight: number,
): number => {
	if (atomicWeight === 0) return 0;

	const beforeWeight = weighValue(before, atomicWeight);
	const afterWeight = weighValue(after, atomicWeight - beforeWeight);
	const collapsedWeight = OPERATION_WEIGHT + beforeWeight + afterWeight;

	if (collapsedWeight < atomicWeight) {
		assertAcyclic(after, path);

		ops.splice(opsStart, ops.length - opsStart, changePair(path, before, after));

		return collapsedWeight;
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

const isObjectLike = (value: unknown): value is object =>
	value !== null && (typeof value === "object" || typeof value === "function");

const sharesStorageIdentity = (before: unknown, after: unknown): boolean =>
	isObjectLike(before) && isObjectLike(after) && isSameIdentity(before, after);

const isCanonicalArrayIndex = (key: string): boolean => {
	const index = Number(key);

	return Number.isInteger(index) && index >= 0 && index < 4_294_967_295 && String(index) === key;
};

const collectComparedKeys = (
	before: Record<string, unknown> | Array<unknown>,
	after: Record<string, unknown> | Array<unknown>,
	ignoreArrayIndexes: boolean,
): Iterable<string> => {
	const keys = new Set<string>();

	for (const key of Object.keys(before)) {
		if (ignoreArrayIndexes && isCanonicalArrayIndex(key)) continue;

		keys.add(key);
	}

	for (const key of Object.keys(after)) {
		if (ignoreArrayIndexes && isCanonicalArrayIndex(key)) continue;

		keys.add(key);
	}

	return keys;
};

const diffObjectProperties = (
	before: Record<string, unknown> | Array<unknown>,
	after: Record<string, unknown> | Array<unknown>,
	path: OperationPath,
	ops: Array<Op>,
	ancestors: Ancestors,
	ignoreArrayIndexes: boolean,
): number => {
	let weight = 0;

	for (const key of collectComparedKeys(before, after, ignoreArrayIndexes)) {
		const nextPath = appendOperationPath(path, key);

		const beforeDescriptor = Reflect.getOwnPropertyDescriptor(before, key);
		const afterDescriptor = Reflect.getOwnPropertyDescriptor(after, key);

		if (beforeDescriptor?.get || afterDescriptor?.get) continue;

		if (!beforeDescriptor) {
			weight += pushAddition(ops, nextPath, Reflect.get(after, key));
		} else if (!afterDescriptor) {
			weight += pushRemoval(ops, nextPath, Reflect.get(before, key));
		} else {
			weight += diffValue(Reflect.get(before, key), Reflect.get(after, key), nextPath, ops, ancestors);
		}
	}

	return weight;
};

const diffArray = (
	before: Array<unknown>,
	after: Array<unknown>,
	path: OperationPath,
	ops: Array<Op>,
	ancestors: Ancestors,
): number => {
	const overlap = Math.min(before.length, after.length);
	let weight = 0;

	for (let index = 0; index < overlap; index++) {
		const beforePresent = Object.hasOwn(before, index);
		const afterPresent = Object.hasOwn(after, index);

		if (!beforePresent && !afterPresent) continue;

		const nextPath = appendOperationPath(path, index);

		if (!beforePresent) weight += pushAddition(ops, nextPath, after[index]);
		else if (!afterPresent) weight += pushRemoval(ops, nextPath, before[index]);
		else weight += diffValue(before[index], after[index], nextPath, ops, ancestors);
	}

	if (after.length > before.length) {
		weight += pushChange(ops, appendOperationPath(path, "length"), before.length, after.length);

		for (let index = before.length; index < after.length; index++) {
			if (Object.hasOwn(after, index)) weight += pushAddition(ops, appendOperationPath(path, index), after[index]);
		}
	} else if (after.length < before.length) {
		for (let index = after.length; index < before.length; index++) {
			if (Object.hasOwn(before, index)) weight += pushRemoval(ops, appendOperationPath(path, index), before[index]);
		}

		weight += pushChange(ops, appendOperationPath(path, "length"), before.length, after.length);
	}

	weight += diffObjectProperties(before, after, path, ops, ancestors, true);

	return weight;
};

const walkContainer = (
	before: object,
	after: object,
	path: OperationPath,
	ops: Array<Op>,
	ancestors: Ancestors,
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

		return tryCollapse(before, after, path, ops, opsStart, atomicWeight);
	} finally {
		exitAncestorPair(ancestors, before, after);
	}
};

const diffValue = (
	before: unknown,
	after: unknown,
	path: OperationPath,
	ops: Array<Op>,
	ancestors: Ancestors,
): number => {
	if (Object.is(before, after)) return 0;

	if (path.length > 0 && isObjectLike(before) && isObjectLike(after) && !sharesStorageIdentity(before, after)) {
		return pushChange(ops, path, before, after);
	}

	if (isPlainArray(before) && isPlainArray(after)) {
		return walkContainer(before, after, path, ops, ancestors, () => diffArray(before, after, path, ops, ancestors));
	}

	if (isPlainObject(before) && isPlainObject(after)) {
		return walkContainer(before, after, path, ops, ancestors, () =>
			diffObjectProperties(before, after, path, ops, ancestors, false),
		);
	}

	return pushChange(ops, path, before, after);
};

const getRootKind = (value: object): RootKind | undefined => {
	if (isPlainArray(value)) return "plainArray";

	if (isPlainObject(value)) return "plainObject";

	return undefined;
};

/**
 * Diffs two plain objects into ops.
 *
 * @param before - Earlier value.
 * @param after - Later value.
 * @returns Ops from before to after.
 */
export function diffSnapshots(before: object, after: object): Array<Op> {
	const beforeKind = getRootKind(before);
	const afterKind = getRootKind(after);

	if (beforeKind === undefined || beforeKind !== afterKind) throw new IncompatibleSnapshotRootsError();

	const ops = new Array<Op>();

	diffValue(before, after, createOperationPath([]), ops, new Map());

	return ops;
}
