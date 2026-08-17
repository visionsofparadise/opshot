import { cloneValue, isCloneable } from "./cloneValue";

/**
 * A half of a change.
 */
export type Operation =
	| { readonly op: "add"; readonly path: string; readonly value: unknown }
	| { readonly op: "replace"; readonly path: string; readonly value: unknown }
	| { readonly op: "remove"; readonly path: string }
	| { readonly op: "mapSet"; readonly path: string; readonly key: unknown; readonly value: unknown }
	| { readonly op: "mapDelete"; readonly path: string; readonly key: unknown }
	| { readonly op: "mapEntries"; readonly path: string; readonly entries: ReadonlyArray<readonly [unknown, unknown]> }
	| { readonly op: "setAdd"; readonly path: string; readonly member: unknown }
	| { readonly op: "setDelete"; readonly path: string; readonly member: unknown }
	| { readonly op: "setEntries"; readonly path: string; readonly members: ReadonlyArray<unknown> }
	| { readonly op: "dateSet"; readonly path: string; readonly epoch: number };

/**
 * A change with do and undo halves.
 */
export interface Op { readonly isPatch: true; readonly do: Operation; readonly undo: Operation }

const operationBrand = Symbol.for("opshot.operation");

const valueOriginal = Symbol("opshot.operation.value");
const entriesOriginal = Symbol("opshot.operation.entries");

const createBrandedPrototype = (defineGetters?: (prototype: object) => void): object => {
	const prototype = {};

	Object.defineProperty(prototype, operationBrand, { value: true });
	defineGetters?.(prototype);

	return prototype;
};

const valuePrototype = createBrandedPrototype((prototype) => {
	Object.defineProperty(prototype, "value", {
		get(this: { readonly path: string }): unknown {
			return cloneValue(Reflect.get(this, valueOriginal), new WeakMap(), this.path);
		},
	});
});

const payloadFreePrototype = createBrandedPrototype();

const entriesPrototype = createBrandedPrototype((prototype) => {
	Object.defineProperty(prototype, "entries", {
		get(this: { readonly path: string }): ReadonlyArray<readonly [unknown, unknown]> {
			const original = Reflect.get(this, entriesOriginal) as ReadonlyArray<readonly [unknown, unknown]>;
			const memo = new WeakMap<object, unknown>();

			return original.map(([key, value]) => [key, cloneValue(value, memo, this.path)] as const);
		},
	});
});

const createHalf = <T extends Operation>(prototype: object, op: T["op"], path: string): T => {
	const half = Object.create(prototype) as T;

	Object.defineProperty(half, "op", { value: op, enumerable: true });
	Object.defineProperty(half, "path", { value: path, enumerable: true });

	return half;
};

const defineValue = (half: object, value: unknown): void => {
	if (isCloneable(value)) Object.defineProperty(half, valueOriginal, { value });
	else Object.defineProperty(half, "value", { value, enumerable: true });
};

const defineIdentity = (half: object, name: string, value: unknown): void => {
	Object.defineProperty(half, name, { value, enumerable: true });
};

export const isOperation = (value: unknown): value is Operation => typeof value === "object" && value !== null && operationBrand in value;

export const createValueOperation = (op: "add" | "replace", path: string, value: unknown): Operation => {
	const half = createHalf<Extract<Operation, { op: "add" | "replace" }>>(valuePrototype, op, path);

	defineValue(half, value);

	return half;
};

export const createRemoveOperation = (path: string): Operation => createHalf<Extract<Operation, { op: "remove" }>>(payloadFreePrototype, "remove", path);

export const createMapSetOperation = (path: string, key: unknown, value: unknown): Operation => {
	const half = createHalf<Extract<Operation, { op: "mapSet" }>>(valuePrototype, "mapSet", path);

	defineIdentity(half, "key", key);
	defineValue(half, value);

	return half;
};

export const createMapDeleteOperation = (path: string, key: unknown): Operation => {
	const half = createHalf<Extract<Operation, { op: "mapDelete" }>>(payloadFreePrototype, "mapDelete", path);

	defineIdentity(half, "key", key);

	return half;
};

export const createMapEntriesOperation = (path: string, entries: ReadonlyArray<readonly [unknown, unknown]>): Operation => {
	const half = createHalf<Extract<Operation, { op: "mapEntries" }>>(entriesPrototype, "mapEntries", path);

	Object.defineProperty(half, entriesOriginal, { value: entries });

	return half;
};

export const createSetAddOperation = (path: string, member: unknown): Operation => {
	const half = createHalf<Extract<Operation, { op: "setAdd" }>>(payloadFreePrototype, "setAdd", path);

	defineIdentity(half, "member", member);

	return half;
};

export const createSetDeleteOperation = (path: string, member: unknown): Operation => {
	const half = createHalf<Extract<Operation, { op: "setDelete" }>>(payloadFreePrototype, "setDelete", path);

	defineIdentity(half, "member", member);

	return half;
};

export const createSetEntriesOperation = (path: string, members: ReadonlyArray<unknown>): Operation => {
	const half = createHalf<Extract<Operation, { op: "setEntries" }>>(payloadFreePrototype, "setEntries", path);

	defineIdentity(half, "members", members);

	return half;
};

export const createDateSetOperation = (path: string, epoch: number): Operation => {
	const half = createHalf<Extract<Operation, { op: "dateSet" }>>(payloadFreePrototype, "dateSet", path);

	defineIdentity(half, "epoch", epoch);

	return half;
};
