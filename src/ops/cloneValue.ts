import { unstable_getInternalStates } from "valtio/vanilla";

// refSet is the only runtime marker ref() leaves on a value; valtio exposes it nowhere else.
const { refSet } = unstable_getInternalStates();

export const isPlainArray = (value: unknown): value is Array<unknown> => Array.isArray(value) && !refSet.has(value);

export const isPlainObject = (value: unknown): value is Record<string, unknown> => {
	if (typeof value !== "object" || value === null || Array.isArray(value) || refSet.has(value)) return false;

	const prototype: unknown = Object.getPrototypeOf(value);

	return prototype === Object.prototype || prototype === null;
};

export const isCloneable = (value: unknown): value is Record<string, unknown> | Array<unknown> => isPlainObject(value) || isPlainArray(value);

export const cyclicError = (pointer: string): Error => new Error(`opshot: cyclic value at ${pointer}; use ignore() for back-linked structures, or ids`);

const cyclicMessagePattern = /^opshot: cyclic value at (.*); use ignore\(\) for back-linked structures, or ids$/;

export const getCyclicErrorPointer = (error: unknown): string | undefined => {
	if (!(error instanceof Error)) return undefined;

	return cyclicMessagePattern.exec(error.message)?.[1];
};

const CLONE_IN_PROGRESS = Symbol("opshot.cloneValue.inProgress");

export const cloneValue = (value: unknown, memo: WeakMap<object, unknown>, pointer: string): unknown => {
	if (!isCloneable(value)) return value;

	const cached = memo.get(value);

	if (cached === CLONE_IN_PROGRESS) throw cyclicError(pointer);
	if (cached !== undefined) return cached;

	memo.set(value, CLONE_IN_PROGRESS);

	// .map skips holes, preserving hole-ness through the clone.
	const clone = isPlainArray(value)
		? value.map((child) => cloneValue(child, memo, pointer))
		: Object.fromEntries(Object.entries(value).map(([key, child]) => [key, cloneValue(child, memo, pointer)]));

	memo.set(value, clone);

	return clone;
};
