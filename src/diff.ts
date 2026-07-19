import { unstable_getInternalStates } from "valtio/vanilla";

// refSet is the only runtime marker ref() leaves on a value; valtio exposes it nowhere else.
const { refSet } = unstable_getInternalStates();

type PathKey = string | number;
type Path = Array<PathKey>;

export type PatchOperation =
	| { readonly op: "add"; readonly path: string; readonly value: unknown }
	| { readonly op: "replace"; readonly path: string; readonly value: unknown }
	| { readonly op: "remove"; readonly path: string };

export interface Op { readonly isPatch: true; readonly do: PatchOperation; readonly undo: PatchOperation }

const isPlainArray = (value: unknown): value is Array<unknown> => Array.isArray(value) && !refSet.has(value);

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
	if (typeof value !== "object" || value === null || Array.isArray(value) || refSet.has(value)) return false;

	const prototype: unknown = Object.getPrototypeOf(value);

	return prototype === Object.prototype || prototype === null;
};

const isCloneable = (value: unknown): value is Record<string, unknown> | Array<unknown> => isPlainObject(value) || isPlainArray(value);

export const toPointer = (path: ReadonlyArray<string | number>): string => {
	if (path.length === 0) return "";

	return `/${path.map((segment) => String(segment).replaceAll("~", "~0").replaceAll("/", "~1")).join("/")}`;
};

// The pointer names the cyclic location per the design's format; "or ids" names the alternative to identity-based back-links.
const cyclicError = (pointer: string): Error => new Error(`opshot: cyclic value at ${pointer}; use ignore() for back-linked structures, or ids`);

const cyclicMessagePattern = /^opshot: cyclic value at (.*); use ignore\(\) for back-linked structures, or ids$/;

export const getCyclicErrorPointer = (error: unknown): string | undefined => {
	if (!(error instanceof Error)) return undefined;

	return cyclicMessagePattern.exec(error.message)?.[1];
};

// Sentinel for a clone still being built; hitting it on a revisit is the memo doubling as the clone walk's own cycle trip.
const CLONE_IN_PROGRESS = Symbol("opshot.cloneValue.inProgress");

const cloneValue = (value: unknown, memo: WeakMap<object, unknown>, pointer: string): unknown => {
	if (!isCloneable(value)) return value;

	const cached = memo.get(value);

	if (cached === CLONE_IN_PROGRESS) throw cyclicError(pointer);
	if (cached !== undefined) return cached;

	memo.set(value, CLONE_IN_PROGRESS);

	// .map skips holes and leaves them unset on the result, which is what preserves hole-ness through the clone.
	const clone = isPlainArray(value)
		? value.map((child) => cloneValue(child, memo, pointer))
		: Object.fromEntries(Object.entries(value).map(([key, child]) => [key, cloneValue(child, memo, pointer)]));

	memo.set(value, clone);

	return clone;
};

const removing = (pointer: string): PatchOperation => ({ op: "remove", path: pointer });

const carrying = (op: "add" | "replace", pointer: string, value: unknown): PatchOperation => {
	if (!isCloneable(value)) return { op, path: pointer, value };

	return {
		op,
		path: pointer,
		get value() {
			return cloneValue(value, new WeakMap(), pointer);
		},
	};
};

const addPair = (pointer: string, after: unknown): Op => ({ isPatch: true, do: carrying("add", pointer, after), undo: removing(pointer) });

const removePair = (pointer: string, before: unknown): Op => ({ isPatch: true, do: removing(pointer), undo: carrying("add", pointer, before) });

const replacePair = (pointer: string, before: unknown, after: unknown): Op => ({
	isPatch: true,
	do: carrying("replace", pointer, after),
	undo: carrying("replace", pointer, before),
});

// Pairs currently on the diff's walk stack, keyed on both sides: a pair (before, after) is present iff after is in the set for before.
// Keying on one side only false-trips a legitimate DAG-on-one-side compared against a cycle-on-the-other; the pair is the sound key.
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

				// Dense-array contract: a mismatched hasOwn at an index reading undefined on either side escalates to a whole-array replace,
				// since per-index absence has no RFC 6902 array representation (remove there means splice-with-shift).
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
				// A getter is the author declaring derived; snapshots keep it live (boundary's createSnapshot replacement), so diffing it would re-materialize derived noise.
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
