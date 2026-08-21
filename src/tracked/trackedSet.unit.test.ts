import { createMutableState } from "../createMutableState";
import { identify, isSameIdentity } from "../identity";
import { ignore } from "../ignore";
import { applyOperations } from "../ops/applyOperations";
import { type Operation } from "../ops/operation";
import { shapeOps } from "../ops/operationShape";
import { subscribe } from "../subscribe";
import { transact } from "../transact/transact";
import { addressOf } from "./address";
import { TrackedSet } from "./trackedSet";

const record = <T extends object>(state: T): Array<Array<Operation>> => {
	const heard = new Array<Array<Operation>>();

	subscribe(state, (ops) => heard.push([...ops]));

	return heard;
};

const asPlainData = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

describe("TrackedSet", () => {
	it("preserves member identity through remove and restore", () => {
		const member = { id: 1 };
		const selection = new Map([[identify(member), "selected"]]);
		const state = createMutableState({ set: new TrackedSet([member]) });
		const heard = record(state);

		transact(state, () => state.set.delete(member));
		const ops = heard[0] ?? [];
		applyOperations(state, ops, "undo");

		const restored = [...state.set][0];

		expect(restored && selection.get(identify(restored))).toBe("selected");
		expect(restored && isSameIdentity(restored, member)).toBe(true);
	});

	it("keeps an ignored member by reference and silent on its interior writes", () => {
		class Point {
			x = 1;
		}

		const member = new Point();
		const state = createMutableState({ set: ignore(new TrackedSet([member])) });
		const heard = record(state);
		const held = [...state.set][0];

		expect(held).toBe(member);

		transact(state, () => {
			const current = [...state.set][0];

			if (typeof current !== "object" || current === null) throw new Error("missing member");

			(current as { x: number }).x = 2;
		});

		expect(heard).toHaveLength(0);
		expect([...state.set][0]).toBe(member);
		expect(member.x).toBe(2);
	});

	it("clear-then-re-add within one window emits net ops that invert to the prior members", () => {
		const state = createMutableState({ set: new TrackedSet(["a", "b"]) });
		const heard = record(state);

		transact(state, () => {
			state.set.clear();
			state.set.add("b");
			state.set.add("a");
			state.set.add("c");
		});

		const ops = heard[0] ?? [];
		const shaped = shapeOps(ops);
		const fields = shaped.map((pair) => pair.do.path[1]);

		expect(fields).toEqual(expect.arrayContaining(["slots", "index", "count"]));
		expect(asPlainData(shaped)).toEqual(shaped);

		applyOperations(state, ops, "undo");
		expect([...state.set]).toEqual(["a", "b"]);

		applyOperations(state, ops, "do");
		expect([...state.set]).toEqual(["b", "a", "c"]);
	});

	it("add and remove emit plain-data assign and delete pairs", () => {
		const state = createMutableState({ set: new TrackedSet(["a", "b"]) });
		const heard = record(state);
		const added = addressOf("c");
		const removed = addressOf("b");

		transact(state, () => {
			state.set.add("c");
		});
		transact(state, () => {
			expect(state.set.delete("b")).toBe(true);
			expect(state.set.delete("b")).toBe(false);
		});

		const shaped = heard.map((ops) => shapeOps(ops));

		expect(asPlainData(shaped)).toEqual(shaped);
		expect(shaped[0]).toEqual([
			{
				do: { verb: "assign", path: ["set", "slots", "length"], value: 3 },
				undo: { verb: "assign", path: ["set", "slots", "length"], value: 2 },
			},
			{
				do: { verb: "assign", path: ["set", "slots", 2], value: ["c"] },
				undo: { verb: "delete", path: ["set", "slots", 2] },
			},
			{
				do: { verb: "assign", path: ["set", "index", added], value: 2 },
				undo: { verb: "delete", path: ["set", "index", added] },
			},
			{
				do: { verb: "assign", path: ["set", "count"], value: 3 },
				undo: { verb: "assign", path: ["set", "count"], value: 2 },
			},
		]);
		expect(shaped[1]).toEqual([
			{
				do: { verb: "assign", path: ["set", "slots", 1], value: null },
				undo: { verb: "assign", path: ["set", "slots", 1], value: ["b"], ids: [4] },
			},
			{
				do: { verb: "delete", path: ["set", "index", removed] },
				undo: { verb: "assign", path: ["set", "index", removed], value: 1 },
			},
			{
				do: { verb: "assign", path: ["set", "count"], value: 2 },
				undo: { verb: "assign", path: ["set", "count"], value: 3 },
			},
		]);
	});

	it("re-add of an existing member keeps insertion order and emits nothing", () => {
		const state = createMutableState({ set: new TrackedSet(["a", "b"]) });
		const heard = record(state);

		transact(state, () => {
			state.set.add("a");
		});

		expect(heard).toHaveLength(0);
		expect([...state.set]).toEqual(["a", "b"]);
	});

	it("has, entries, keys, forEach, and clear follow surviving members after a delete", () => {
		const set = new TrackedSet(["a", "b", "c"]);
		const calls = new Array<[string, string, boolean]>();

		expect(set.delete("b")).toBe(true);
		expect(set.has("a")).toBe(true);
		expect(set.has("b")).toBe(false);
		expect(set.has("c")).toBe(true);
		expect([...set.entries()]).toEqual([
			["a", "a"],
			["c", "c"],
		]);
		expect([...set.keys()]).toEqual(["a", "c"]);
		expect([...set.values()]).toEqual(["a", "c"]);

		set.forEach((value, key, received) => {
			calls.push([value, key, received === set]);
		});

		expect(calls).toEqual([
			["a", "a", true],
			["c", "c", true],
		]);

		set.clear();
		expect(set.size).toBe(0);
		expect([...set]).toEqual([]);
	});
});
