import { isSameIdentity } from "../identity";
import { cyclicError, isPlainArray, isPlainObject } from "./cloneValue";
import { createAddOperation, createRemoveOperation, createReplaceOperation, type Op } from "./operation";
import { appendOperationPath, assertSafePath, createOperationPath, type OperationPath } from "./path";
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

const addPair = (path: OperationPath, after: unknown): Op => ({
	do: createAddOperation(path, after),
	undo: createRemoveOperation(path),
});

const removePair = (path: OperationPath, before: unknown): Op => ({
	do: createRemoveOperation(path),
	undo: createAddOperation(path, before),
});

const replacePair = (path: OperationPath, before: unknown, after: unknown): Op => ({
	do: createReplaceOperation(path, after),
	undo: createReplaceOperation(path, before),
});

const weighCarried = (value: unknown): number => weighValue(value, UNCAPPED_WEIGHT);

const pushAdd = (ops: Array<Op>, path: OperationPath, after: unknown): number => {
	ops.push(addPair(path, after));

	return OPERATION_WEIGHT + weighCarried(after);
};

const pushRemove = (ops: Array<Op>, path: OperationPath, before: unknown): number => {
	ops.push(removePair(path, before));

	return OPERATION_WEIGHT + weighCarried(before);
};

const pushReplace = (ops: Array<Op>, path: OperationPath, before: unknown, after: unknown): number => {
	ops.push(replacePair(path, before, after));

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
		assertSafeSubtree(before, path);
		assertSafeSubtree(after, path);
		ops.splice(opsStart, ops.length - opsStart, replacePair(path, before, after));

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

const assertSafeSubtree = (value: unknown, path: OperationPath, activeAncestors = new WeakSet()): void => {
	if (!isPlainArray(value) && !isPlainObject(value)) return;

	if (activeAncestors.has(value)) return;

	activeAncestors.add(value);

	try {
		for (const key of Object.keys(value)) {
			const nextPath = appendOperationPath(path, key);

			assertSafePath(nextPath);

			const descriptor = Reflect.getOwnPropertyDescriptor(value, key);

			if (descriptor && "value" in descriptor) assertSafeSubtree(descriptor.value, nextPath, activeAncestors);
		}
	} finally {
		activeAncestors.delete(value);
	}
};

const isCanonicalArrayIndex = (key: string): boolean => {
	const index = Number(key);

	return Number.isInteger(index) && index >= 0 && index < 4_294_967_295 && String(index) === key;
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

	for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
		if (ignoreArrayIndexes && isCanonicalArrayIndex(key)) continue;

		const nextPath = appendOperationPath(path, key);

		assertSafePath(nextPath);

		const beforeDescriptor = Reflect.getOwnPropertyDescriptor(before, key);
		const afterDescriptor = Reflect.getOwnPropertyDescriptor(after, key);

		if (beforeDescriptor?.get || afterDescriptor?.get) continue;

		if (!beforeDescriptor) {
			assertSafeSubtree(Reflect.get(after, key), nextPath);
			weight += pushAdd(ops, nextPath, Reflect.get(after, key));
		} else if (!afterDescriptor) {
			assertSafeSubtree(Reflect.get(before, key), nextPath);
			weight += pushRemove(ops, nextPath, Reflect.get(before, key));
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
		const nextPath = appendOperationPath(path, index);

		if (!beforePresent && !afterPresent) continue;

		if (!beforePresent) weight += pushAdd(ops, nextPath, after[index]);
		else if (!afterPresent) weight += pushRemove(ops, nextPath, before[index]);
		else weight += diffValue(before[index], after[index], nextPath, ops, ancestors);
	}

	if (after.length > before.length) {
		weight += pushReplace(ops, appendOperationPath(path, "length"), before.length, after.length);

		for (let index = before.length; index < after.length; index++) {
			if (Object.hasOwn(after, index)) weight += pushAdd(ops, appendOperationPath(path, index), after[index]);
		}
	} else if (after.length < before.length) {
		for (let index = after.length; index < before.length; index++) {
			if (Object.hasOwn(before, index)) weight += pushRemove(ops, appendOperationPath(path, index), before[index]);
		}

		weight += pushReplace(ops, appendOperationPath(path, "length"), before.length, after.length);
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
		assertSafeSubtree(before, path);
		assertSafeSubtree(after, path);

		return pushReplace(ops, path, before, after);
	}

	if (isPlainArray(before) && isPlainArray(after)) {
		return walkContainer(before, after, path, ops, ancestors, () => diffArray(before, after, path, ops, ancestors));
	}

	if (isPlainObject(before) && isPlainObject(after)) {
		return walkContainer(before, after, path, ops, ancestors, () =>
			diffObjectProperties(before, after, path, ops, ancestors, false),
		);
	}

	assertSafeSubtree(before, path);
	assertSafeSubtree(after, path);

	return pushReplace(ops, path, before, after);
};

const getRootKind = (value: object): RootKind | undefined => {
	if (isPlainArray(value)) return "plainArray";

	if (isPlainObject(value)) return "plainObject";

	return undefined;
};

export function diffSnapshots(before: object, after: object): Array<Op> {
	const beforeKind = getRootKind(before);
	const afterKind = getRootKind(after);

	if (beforeKind === undefined || beforeKind !== afterKind) throw new IncompatibleSnapshotRootsError();

	const ops = new Array<Op>();

	diffValue(before, after, createOperationPath([]), ops, new Map());

	return ops;
}
