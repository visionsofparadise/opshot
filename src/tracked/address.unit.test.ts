import { createMutableState } from "../createMutableState";
import { TrackedMap } from "./trackedMap";

describe("§2.2 assigning a node into a state it currently occupies keeps its identity in that state", () => {
	it("addresses the same object as raw and as the proxy the state returns", () => {
		const key = { id: 1 };
		const state = createMutableState({
			map: new TrackedMap<object, string>([[key, "held"]]),
			key,
		});

		expect(state.map.get(key)).toBe("held");
		expect(state.map.get(state.key)).toBe("held");
		expect(state.map.has(state.key)).toBe(true);
	});

	it("gives distinct equal-content objects distinct addresses", () => {
		const first = { label: "same" };
		const second = { label: "same" };
		const map = new TrackedMap<object, string>([
			[first, "first"],
			[second, "second"],
		]);

		expect(map.get(first)).toBe("first");
		expect(map.get(second)).toBe("second");
		expect(map.size).toBe(2);
	});

	it("keeps keys of different types from colliding", () => {
		const map = new TrackedMap<unknown, string>([
			[5, "number"],
			["5", "string"],
			[true, "bool"],
			[null, "null"],
			[undefined, "undef"],
		]);

		expect(map.get(5)).toBe("number");
		expect(map.get("5")).toBe("string");
		expect(map.get(true)).toBe("bool");
		expect(map.get(null)).toBe("null");
		expect(map.get(undefined)).toBe("undef");
	});

	it("SameValueZero folds -0 with 0", () => {
		const map = new TrackedMap<number, string>([[0, "zero"]]);

		expect(map.get(-0)).toBe("zero");
		expect(map.has(-0)).toBe(true);
	});
});
