import { subscribe } from "../subscribe";
import { transact } from "../transact/transact";
import { createMutableState } from "../createMutableState";
import { identify, isSameIdentity } from "../identity";
import { applyOperations } from "../ops/applyOperations";
import { type Operation } from "../ops/operation";
import { TrackedDate } from "./trackedDate";
import { TrackedMap } from "./trackedMap";

const record = <T extends object>(state: T): Array<Array<Operation>> => {
	const heard = new Array<Array<Operation>>();

	subscribe(state, (ops) => heard.push([...ops]));

	return heard;
};

describe("TrackedMap", () => {
	it("preserves object-key identity and aliased values through replay", () => {
		const key = { id: 1 };
		const shared = { count: 1 };
		const state = createMutableState({
			map: new TrackedMap([
				[key, shared],
				[{ id: 2 }, shared],
			]),
		});
		const selection = new Map([[identify(key), "selected"]]);
		const heard = record(state);

		transact(state, () => state.map.clear());
		const ops = heard[0] ?? [];
		applyOperations(state, ops, "undo");

		const entries = [...state.map];

		expect(entries[0]?.[0] && selection.get(identify(entries[0][0]))).toBe("selected");
		expect(entries[0]?.[1]).toBe(entries[1]?.[1]);
		expect(entries[0]?.[1] && isSameIdentity(entries[0][1], shared)).toBe(true);
	});

	it("recurses through nested arrays and facades on stable map values", () => {
		const state = createMutableState({ map: new TrackedMap([["a", { items: ["x"], when: new TrackedDate(0) }]]) });
		const heard = record(state);

		transact(state, () => {
			const value = state.map.get("a");

			if (!value) throw new Error("missing value");
			value.items.push("y");
			value.when.setTime(1);
		});

		const ops = heard[0] ?? [];
		applyOperations(state, ops, "undo");
		expect(state.map.get("a")?.items).toEqual(["x"]);
		expect(state.map.get("a")?.when.getTime()).toBe(0);
		applyOperations(state, ops, "do");
		expect(state.map.get("a")?.items).toEqual(["x", "y"]);
		expect(state.map.get("a")?.when.getTime()).toBe(1);
	});

	it("emits nothing when a re-set stores an Object.is-equal value", () => {
		const state = createMutableState({ map: new TrackedMap<string, number>([["a", 1]]) });
		const heard = record(state);

		transact(state, () => {
			state.map.set("a", 1);
		});

		expect(heard).toHaveLength(0);

		transact(state, () => {
			state.map.set("a", 2);
		});

		expect(heard).toHaveLength(1);
	});
});
