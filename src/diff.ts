import { unstable_getInternalStates } from "valtio/vanilla";

// refSet is the only runtime marker ref() leaves on a value; valtio exposes it nowhere else.
const { refSet } = unstable_getInternalStates();

type PathKey = string | number;
type Path = Array<PathKey>;

export type PatchOperation =
	| { readonly op: "add"; readonly path: string; readonly value: unknown }
	| { readonly op: "replace"; readonly path: string; readonly value: unknown }
	| { readonly op: "remove"; readonly path: string };

export interface Op { readonly do: PatchOperation; readonly undo: PatchOperation }

const isPlainArray = (value: unknown): value is Array<unknown> => Array.isArray(value) && !refSet.has(value);

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
	if (typeof value !== "object" || value === null || Array.isArray(value) || refSet.has(value)) return false;

	const prototype: unknown = Object.getPrototypeOf(value);

	return prototype === Object.prototype || prototype === null;
};

const isCloneable = (value: unknown): value is Record<string, unknown> | Array<unknown> => isPlainObject(value) || isPlainArray(value);

const cloneValue = (value: unknown): unknown => {
	if (isPlainArray(value)) return value.map(cloneValue);

	if (isPlainObject(value)) {
		return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, cloneValue(child)]));
	}

	return value;
};

const toPointer = (path: Path): string => {
	if (path.length === 0) return "";

	return `/${path.map((segment) => String(segment).replaceAll("~", "~0").replaceAll("/", "~1")).join("/")}`;
};

const removing = (pointer: string): PatchOperation => ({ op: "remove", path: pointer });

const carrying = (op: "add" | "replace", pointer: string, value: unknown): PatchOperation => {
	if (!isCloneable(value)) return { op, path: pointer, value };

	return {
		op,
		path: pointer,
		get value() {
			return cloneValue(value);
		},
	};
};

const addPair = (pointer: string, after: unknown): Op => ({ do: carrying("add", pointer, after), undo: removing(pointer) });

const removePair = (pointer: string, before: unknown): Op => ({ do: removing(pointer), undo: carrying("add", pointer, before) });

const replacePair = (pointer: string, before: unknown, after: unknown): Op => ({
	do: carrying("replace", pointer, after),
	undo: carrying("replace", pointer, before),
});

const diffValue = (before: unknown, after: unknown, path: Path, ops: Array<Op>): void => {
	if (Object.is(before, after)) return;

	if (isPlainArray(before) && isPlainArray(after)) {
		if (before.length !== after.length) {
			ops.push(replacePair(toPointer(path), before, after));

			return;
		}

		for (let index = 0; index < after.length; index++) diffValue(before[index], after[index], [...path, index], ops);

		return;
	}

	if (isPlainObject(before) && isPlainObject(after)) {
		for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
			if (!Object.hasOwn(before, key)) ops.push(addPair(toPointer([...path, key]), after[key]));
			else if (!Object.hasOwn(after, key)) ops.push(removePair(toPointer([...path, key]), before[key]));
			else diffValue(before[key], after[key], [...path, key], ops);
		}

		return;
	}

	ops.push(replacePair(toPointer(path), before, after));
};

export function diffSnapshots(before: unknown, after: unknown): Array<Op> {
	const ops: Array<Op> = [];

	diffValue(before, after, [], ops);

	return ops;
}
