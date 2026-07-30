import { transact } from "../transact";
import { subscribe } from "../subscribe";
import { createMutableState } from "../createMutableState";
import { cloneValue } from "./cloneValue";
import { type Operation } from "./operation";
import { createOperationPath } from "./path";

const readWholeValueUndo = (value: object): object => {
	const state = createMutableState<{ value: object | null }>({ value });
	let undo: Operation | undefined;

	subscribe(state, (ops) => {
		undo = ops[0]?.undo;
	});

	transact(state, () => {
		state.value = null;
	});

	if (undo?.op !== "assign") throw new Error("expected a whole-value assign undo");

	const cloned = undo.value;

	if (typeof cloned !== "object" || cloned === null) throw new Error("expected an object undo value");

	return cloned;
};

describe("cloneValue", () => {
	it("preserves a null prototype on a whole op value", () => {
		const value = Object.assign(Object.create(null) as Record<string, unknown>, { nested: { count: 1 } });
		const cloned = readWholeValueUndo(value);

		expect(Reflect.getPrototypeOf(cloned)).toBeNull();
		expect(Reflect.get(cloned, "nested")).toEqual({ count: 1 });
	});

	it("preserves a live accessor on a whole op value", () => {
		let current = 1;
		const getCurrent = (): number => current;
		const value = Object.defineProperty({}, "current", { get: getCurrent, enumerable: true, configurable: true });
		const cloned = readWholeValueUndo(value);
		const descriptor = Reflect.getOwnPropertyDescriptor(cloned, "current");

		expect(descriptor?.get).toBe(getCurrent);
		expect(Reflect.get(cloned, "current")).toBe(1);

		current = 2;

		expect(Reflect.get(cloned, "current")).toBe(2);
	});

	it("preserves symbol and non-enumerable ride-along keys on a whole op value", () => {
		const symbolKey = Symbol("rideAlong");
		const value = { visible: true } as Record<PropertyKey, unknown>;

		Object.defineProperty(value, "hidden", {
			value: { count: 1 },
			enumerable: false,
			configurable: true,
			writable: true,
		});
		Object.defineProperty(value, symbolKey, {
			value: { count: 2 },
			enumerable: true,
			configurable: true,
			writable: true,
		});

		const cloned = readWholeValueUndo(value);

		expect(Reflect.ownKeys(cloned)).toEqual(["visible", "hidden", symbolKey]);
		expect(Reflect.getOwnPropertyDescriptor(cloned, "hidden")?.enumerable).toBe(false);
		expect(Reflect.get(cloned, "hidden")).toEqual({ count: 1 });
		expect(Reflect.get(cloned, symbolKey)).toEqual({ count: 2 });
	});

	it("preserves mixed interior and trailing holes in a whole-array clone", () => {
		const value = [1, 2, 3];

		delete value[1];
		value.length = 6;

		const cloned = cloneValue(value, new WeakMap(), createOperationPath(["value"]));

		expect(Array.isArray(cloned)).toBe(true);

		if (!Array.isArray(cloned)) throw new Error("expected an array clone");

		expect(cloned).toHaveLength(6);
		expect(cloned[0]).toBe(1);
		expect(cloned[2]).toBe(3);
		expect([1, 3, 4, 5].map((index) => Object.hasOwn(cloned, index))).toEqual([false, false, false, false]);
	});

	it("preserves array own descriptors on a whole operation value", () => {
		const symbolKey = Symbol("rideAlong");
		const getCurrent = (): number => 4;
		const value = [{ count: 1 }];

		value.length = 3;
		Object.defineProperty(value, "label", {
			value: { count: 2 },
			enumerable: true,
			configurable: true,
			writable: true,
		});
		Object.defineProperty(value, "hidden", {
			value: { count: 3 },
			enumerable: false,
			configurable: true,
			writable: true,
		});
		Object.defineProperty(value, "current", { get: getCurrent, enumerable: true, configurable: true });
		Object.defineProperty(value, symbolKey, {
			value: { count: 4 },
			enumerable: true,
			configurable: true,
			writable: true,
		});

		const cloned = readWholeValueUndo(value);

		expect(Array.isArray(cloned)).toBe(true);

		if (!Array.isArray(cloned)) throw new Error("expected an array clone");

		expect(cloned).toHaveLength(3);
		expect(Object.hasOwn(cloned, 1)).toBe(false);
		expect(Object.hasOwn(cloned, 2)).toBe(false);
		expect(Reflect.get(cloned, "label")).toEqual({ count: 2 });
		expect(Reflect.getOwnPropertyDescriptor(cloned, "label")?.enumerable).toBe(true);
		expect(Reflect.get(cloned, "hidden")).toEqual({ count: 3 });
		expect(Reflect.getOwnPropertyDescriptor(cloned, "hidden")?.enumerable).toBe(false);
		expect(Reflect.getOwnPropertyDescriptor(cloned, "current")?.get).toBe(getCurrent);
		expect(Reflect.get(cloned, symbolKey)).toEqual({ count: 4 });
		expect(Reflect.getOwnPropertyDescriptor(cloned, symbolKey)?.enumerable).toBe(true);
	});

	it("leaves dense-array clones unchanged", () => {
		const cloned = cloneValue([1, 2, 3], new WeakMap(), createOperationPath(["value"]));

		expect(cloned).toEqual([1, 2, 3]);
		expect(Reflect.ownKeys(cloned as object)).toEqual(["0", "1", "2", "length"]);
	});

	it("preserves a null prototype on a cloned array", () => {
		const value: Array<number> = [1, 2, 3];

		Reflect.setPrototypeOf(value, null);

		const cloned = cloneValue(value, new WeakMap(), createOperationPath(["value"]));

		expect(Array.isArray(cloned)).toBe(true);
		expect(Reflect.getPrototypeOf(cloned as object)).toBeNull();
		expect(Array.from({ length: 3 }, (_, index) => (cloned as Array<number>)[index])).toEqual([1, 2, 3]);
	});

	it("preserves a non-writable data property", () => {
		const value = {};

		Object.defineProperty(value, "locked", {
			value: { count: 1 },
			writable: false,
			enumerable: true,
			configurable: true,
		});

		const cloned = cloneValue(value, new WeakMap(), createOperationPath(["value"]));
		const descriptor = Reflect.getOwnPropertyDescriptor(cloned as object, "locked");

		expect(descriptor?.writable).toBe(false);
		expect(descriptor?.value).toEqual({ count: 1 });
	});
});
