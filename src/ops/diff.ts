import { cyclicError, isPlainArray, isPlainObject } from "./cloneValue";
import { createRemoveOperation, createValueOperation, type Op } from "./operation";
import { toPointer } from "./pointer";

type PathKey = string | number;
type Path = Array<PathKey>;

const addPair = (pointer: string, after: unknown): Op => ({ isPatch: true, do: createValueOperation("add", pointer, after), undo: createRemoveOperation(pointer) });

const removePair = (pointer: string, before: unknown): Op => ({ isPatch: true, do: createRemoveOperation(pointer), undo: createValueOperation("add", pointer, before) });

const replacePair = (pointer: string, before: unknown, after: unknown): Op => ({
	isPatch: true,
	do: createValueOperation("replace", pointer, after),
	undo: createValueOperation("replace", pointer, before),
});

// Keyed on both sides, not one: keying on one side alone false-trips a DAG-on-one-side against a cycle-on-the-other.
type Ancestors = Map<object, Set<object>>;

const hasAncestorPair = (ancestors: Ancestors, before: object, after: object): boolean => ancestors.get(before)?.has(after) ?? false;

const enterAncestorPair = (ancestors: Ancestors, before: object, after: object): void => {
	let afterSet = ancestors.get(before);

	if (!afterSet) {
		afterSet = new Set();
		ancestors.set(before, afterSet);
	}

	afterSet.add(after);
};

const exitAncestorPair = (ancestors: Ancestors, before: object, after: object): void => {
	const afterSet = ancestors.get(before);

	if (!afterSet) return;

	afterSet.delete(after);

	if (afterSet.size === 0) ancestors.delete(before);
};

const diffValue = (before: unknown, after: unknown, path: Path, ops: Array<Op>, ancestors: Ancestors): void => {
	if (Object.is(before, after)) return;

	if (isPlainArray(before) && isPlainArray(after)) {
		const pointer = toPointer(path);

		if (before.length !== after.length) {
			ops.push(replacePair(pointer, before, after));

			return;
		}

		if (hasAncestorPair(ancestors, before, after)) throw cyclicError(pointer);

		enterAncestorPair(ancestors, before, after);

		try {
			const indexOps: Array<Op> = [];
			let presenceMismatch = false;

			for (let index = 0; index < after.length; index++) {
				const beforeValue = before[index];
				const afterValue = after[index];

				// Per-index absence has no RFC 6902 array representation (remove splices-with-shift), so a hasOwn mismatch escalates to a whole-array replace.
				if ((beforeValue === undefined || afterValue === undefined) && Object.hasOwn(before, index) !== Object.hasOwn(after, index)) {
					presenceMismatch = true;

					break;
				}

				diffValue(beforeValue, afterValue, [...path, index], indexOps, ancestors);
			}

			if (presenceMismatch) ops.push(replacePair(pointer, before, after));
			else ops.push(...indexOps);
		} finally {
			exitAncestorPair(ancestors, before, after);
		}

		return;
	}

	if (isPlainObject(before) && isPlainObject(after)) {
		const pointer = toPointer(path);

		if (hasAncestorPair(ancestors, before, after)) throw cyclicError(pointer);

		enterAncestorPair(ancestors, before, after);

		try {
			for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
				// Skip getters: author-declared derived, kept live by snapshots, so diffing them re-materializes derived noise.
				if (Object.getOwnPropertyDescriptor(before, key)?.get || Object.getOwnPropertyDescriptor(after, key)?.get) continue;

				if (!Object.hasOwn(before, key)) ops.push(addPair(toPointer([...path, key]), after[key]));
				else if (!Object.hasOwn(after, key)) ops.push(removePair(toPointer([...path, key]), before[key]));
				else diffValue(before[key], after[key], [...path, key], ops, ancestors);
			}
		} finally {
			exitAncestorPair(ancestors, before, after);
		}

		return;
	}

	ops.push(replacePair(toPointer(path), before, after));
};

export function diffSnapshots(before: unknown, after: unknown): Array<Op> {
	const ops: Array<Op> = [];

	diffValue(before, after, [], ops, new Map());

	return ops;
}
