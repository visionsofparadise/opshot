import { createState } from "../createState";
import { getRegisteredTarget } from "../identity";
import {
	createAddOperation,
	createMembershipAddOperation,
	createRemoveOperation,
	createReplaceOperation,
	getValueOriginal,
	isOperation,
	type Operation,
} from "./operation";

const readValue = (half: Operation): unknown => ("value" in half ? half.value : undefined);

describe("operation", () => {
	it("mints a fresh equal clone on every read of a cloneable value", () => {
		const original = { nested: { x: 1 }, list: [1, 2] };
		const half = createAddOperation(["node"], original);

		expect(readValue(half)).not.toBe(readValue(half));
		expect(readValue(half)).toEqual(original);
		expect(getValueOriginal(half)).toBe(original);
	});

	it("keeps non-cloneable values directly readable", () => {
		const run = (): string => "a";
		const half = createReplaceOperation(["run"], run);

		expect(half.value).toBe(run);
		expect(Object.getOwnPropertyDescriptor(half, "value")?.enumerable).toBe(true);
	});

	it("distinguishes map and membership additions by value presence", () => {
		const mapUndefined = createAddOperation(["map", "key"], undefined, 4);
		const membership = createMembershipAddOperation(["set", "member"], 7);

		expect("value" in mapUndefined).toBe(true);
		expect("value" in mapUndefined ? mapUndefined.value : "missing").toBeUndefined();
		expect("slot" in mapUndefined ? mapUndefined.slot : undefined).toBe(4);
		expect("value" in membership).toBe(false);
		expect("slot" in membership ? membership.slot : undefined).toBe(7);
	});

	it("stores a frozen copied path on every half", () => {
		const source = ["document", 1];
		const halves = [createAddOperation(source, 1), createReplaceOperation(source, 2), createRemoveOperation(source), createMembershipAddOperation(source, 0)];

		source[0] = "changed";

		for (const half of halves) {
			expect(half.path).toEqual(["document", 1]);
			expect(Object.isFrozen(half.path)).toBe(true);
		}
	});

	it("keeps originals registered while public clone reads are independent", () => {
		const state = createState({ value: { count: 1 } });
		const half = createReplaceOperation(["value"], state.value);
		const publicValue = half.value;

		expect(getRegisteredTarget(state.value)).toBeDefined();
		expect(getValueOriginal(half)).toBe(state.value);
		expect(publicValue).toEqual({ count: 1 });
		expect(publicValue).not.toBe(state.value);
		if (typeof publicValue !== "object" || publicValue === null) throw new Error("expected cloned value");
		expect(getRegisteredTarget(publicValue)).toBeUndefined();
	});

	it("brands originals and rejects spread, JSON, and structuredClone copies", () => {
		const half = createAddOperation(["node"], { nested: true });

		expect(isOperation(half)).toBe(true);
		expect(isOperation({ ...half })).toBe(false);
		expect(isOperation(JSON.parse(JSON.stringify(half)))).toBe(false);
		expect(isOperation(structuredClone(half))).toBe(false);
	});

	it("keeps halves branded through an envelope spread", () => {
		const envelope = { isPatch: true, do: createAddOperation(["node"], { nested: true }), undo: createRemoveOperation(["node"]) };
		const spread = { ...envelope };

		expect(isOperation(spread.do)).toBe(true);
		expect(isOperation(spread.undo)).toBe(true);
	});
});
