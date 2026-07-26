import { createMutableState } from "../createMutableState";
import { getRegisteredTarget } from "../identity";
import { TrackedDate } from "../tracked/trackedDate";
import { TrackedMap } from "../tracked/trackedMap";
import { TrackedSet } from "../tracked/trackedSet";
import { isCloneable } from "./cloneValue";
import {
	createAddOperation,
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

	it("stores a frozen copied path on every half", () => {
		const source = ["document", 1];
		const halves = [createAddOperation(source, 1), createReplaceOperation(source, 2), createRemoveOperation(source)];

		source[0] = "changed";

		for (const half of halves) {
			expect(half.path).toEqual(["document", 1]);
			expect(Object.isFrozen(half.path)).toBe(true);
		}
	});

	it("keeps originals registered while public clone reads are independent", () => {
		const state = createMutableState({ value: { count: 1 } });
		const half = createReplaceOperation(["value"], state.value);
		const publicValue = half.value;

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
		const envelope = { do: createAddOperation(["node"], { nested: true }), undo: createRemoveOperation(["node"]) };
		const spread = { ...envelope };

		expect(isOperation(spread.do)).toBe(true);
		expect(isOperation(spread.undo)).toBe(true);
	});

	it("clones plain-data facade op values through the generic path", () => {
		const map = new TrackedMap([["a", 1]]);
		const set = new TrackedSet([1]);
		const date = new TrackedDate(0);

		expect(isCloneable(map)).toBe(true);
		expect(isCloneable(set)).toBe(true);
		expect(isCloneable(date)).toBe(true);

		const mapHalf = createReplaceOperation(["map"], map);
		const setHalf = createReplaceOperation(["set"], set);
		const dateHalf = createReplaceOperation(["date"], date);

		expect(mapHalf.value).not.toBe(map);
		expect(setHalf.value).not.toBe(set);
		expect(dateHalf.value).not.toBe(date);
		expect(mapHalf.value).toBeInstanceOf(TrackedMap);
		expect(setHalf.value).toBeInstanceOf(TrackedSet);
		expect(dateHalf.value).toBeInstanceOf(TrackedDate);
		expect([...(mapHalf.value as TrackedMap<string, number>)]).toEqual([["a", 1]]);
		expect([...(setHalf.value as TrackedSet<number>)]).toEqual([1]);
		expect((dateHalf.value as TrackedDate).getTime()).toBe(0);
		expect(getValueOriginal(mapHalf)).toBe(map);
	});
});
