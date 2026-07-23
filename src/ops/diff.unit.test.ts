import { snapshot } from "valtio/vanilla";

import { subscribe } from "../subscribe";
import { transact } from "../transact";
import { createMutableState } from "../createMutableState";
import { addressOf } from "../tracked/address";
import { TrackedDate } from "../tracked/trackedDate";
import { TrackedMap } from "../tracked/trackedMap";
import { TrackedSet } from "../tracked/trackedSet";
import { applyOps } from "./applyOps";
import { diffSnapshots } from "./diff";
import { type Op, type Operation } from "./operation";

const readValue = (operation: Operation): unknown => ("value" in operation ? operation.value : undefined);

const record = <T extends object>(state: T): Array<Array<Op>> => {
	const heard = new Array<Array<Op>>();

	subscribe(state, (ops) => heard.push([...ops]));

	return heard;
};

const replayUndo = <T extends object>(state: T, ops: Array<Op>): void => applyOps(state, [...ops].reverse().map((pair) => pair.undo));
const replayDo = <T extends object>(state: T, ops: Array<Op>): void => applyOps(state, ops.map((pair) => pair.do));

describe("diffSnapshots: atomic flat paths", () => {
	it("emits add, replace, and remove pairs at frozen array paths", () => {
		const ops = diffSnapshots({ kept: 1, changed: 2, removed: 3 }, { kept: 1, changed: 4, added: 5 });

		expect(ops).toEqual([
			{ do: { op: "replace", path: ["changed"], value: 4 }, undo: { op: "replace", path: ["changed"], value: 2 } },
			{ do: { op: "remove", path: ["removed"] }, undo: { op: "add", path: ["removed"], value: 3 } },
			{ do: { op: "add", path: ["added"], value: 5 }, undo: { op: "remove", path: ["added"] } },
		]);
		for (const pair of ops) expect(Object.isFrozen(pair.do.path)).toBe(true);
	});

	it("recurses only while storage identity is continuous", () => {
		const state = createMutableState({ retained: { count: 1 }, replaced: { count: 1 } });
		const before = snapshot(state);

		transact(state, () => {
			state.retained.count = 2;
			state.replaced = { count: 2 };
		});

		const ops = diffSnapshots(before, snapshot(state));

		expect(ops.map((pair) => pair.do.path)).toEqual([["retained", "count"], ["replaced"]]);
		expect(readValue(ops[1]?.do ?? { op: "remove", path: [] })).toEqual({ count: 2 });
	});

	it("rejects primitive, unsupported, and incompatible roots", () => {
		expect(() => diffSnapshots(1 as unknown as object, 2 as unknown as object)).toThrow("compatible supported object roots");
		expect(() => diffSnapshots({}, [])).toThrow("compatible supported object roots");
		expect(() => diffSnapshots(new Map(), new Map())).toThrow("compatible supported object roots");
	});

	it("accepts plain-data facades as object-container roots", () => {
		const before = new TrackedMap([["a", 1]]);
		const after = new TrackedMap([["a", 2]]);

		expect(() => diffSnapshots(before, after)).not.toThrow();
	});

	it("rejects reserved paths before emitting", () => {
		const polluted = Object.create(null);
		const aliasedPrototype = { prototype: { polluted: true } };

		Object.defineProperty(polluted, "__proto__", { value: { polluted: true }, enumerable: true });

		expect(() => diffSnapshots({}, polluted)).toThrow("reserved operation path");
		expect(() => diffSnapshots({}, { constructor: { prototype: { polluted: true } } })).toThrow("reserved operation path");
		expect(() => diffSnapshots({}, { boundary: { safe: aliasedPrototype, constructor: aliasedPrototype } })).toThrow(
			"reserved operation path /boundary/constructor/prototype",
		);
	});

	it("orders sparse growth length before tail additions and preserves holes", () => {
		const before = [1];
		const after = new Array<unknown>(1);

		after[0] = 1;

		after.length = 4;
		after[3] = undefined;

		const ops = diffSnapshots(before, after);

		expect(ops.map((pair) => pair.do)).toEqual([
			{ op: "replace", path: ["length"], value: 4 },
			{ op: "add", path: [3], value: undefined },
		]);
	});

	it("orders truncated removals before shrink and reverse undo expands first", () => {
		const before = [1, 2, 3];
		const after = [1];
		const ops = diffSnapshots(before, after);

		expect(ops.map((pair) => pair.do)).toEqual([
			{ op: "remove", path: [1] },
			{ op: "remove", path: [2] },
			{ op: "replace", path: ["length"], value: 1 },
		]);
		expect([...ops].reverse().map((pair) => pair.undo)).toEqual([
			{ op: "replace", path: ["length"], value: 3 },
			{ op: "add", path: [2], value: 3 },
			{ op: "add", path: [1], value: 2 },
		]);
	});

	it("distinguishes holes from stored undefined in overlap", () => {
		const hole = new Array<unknown>(1);
		const stored = [undefined];

		expect(diffSnapshots(hole, stored)[0]?.do).toEqual({ op: "add", path: [0], value: undefined });
		expect(diffSnapshots(stored, hole)[0]?.do).toEqual({ op: "remove", path: [0] });
	});

	it("emits enumerable array non-index string properties as ordinary paths", () => {
		const before = [1];
		const after = [1];

		Object.defineProperty(before, "label", { value: "a", enumerable: true });
		Object.defineProperty(after, "label", { value: "b", enumerable: true });

		expect(diffSnapshots(before, after)[0]?.do).toEqual({ op: "replace", path: ["label"], value: "b" });
	});

	it("emits stable Map key and value interiors through slots", () => {
		const key = { id: 1 };
		const value = { count: 1 };
		const pad = "x".repeat(5_000);
		const state = createMutableState({
			map: new TrackedMap<object | string, object | string>([
				[key, value],
				["pad0", pad],
				["pad1", pad],
			]),
		});
		const heard = record(state);

		transact(state, () => {
			const mutableValue = state.map.get(key) as typeof value | undefined;

			if (!mutableValue) throw new Error("entry missing");
			mutableValue.count = 2;
		});
		transact(state, () => {
			const mutableKey = [...state.map.keys()][0] as typeof key;

			if (!mutableKey) throw new Error("key missing");
			mutableKey.id = 2;
		});

		expect(heard[0]?.[0]?.do.path).toEqual(["map", "slots", 0, 1, "count"]);
		expect(heard[1]?.[0]?.do.path).toEqual(["map", "slots", 0, 0, "id"]);
	});

	it("emits plain-data membership ops for Map and Set deletes", () => {
		const pad = "x".repeat(5_000);
		const map = new TrackedMap<string, string>();
		const set = new TrackedSet<string>();

		for (let index = 0; index < 20; index++) {
			map.set(`pad${index}`, pad);
			set.add(`pad${index}${pad}`);
		}

		map.set("target", "1");
		set.add("target");

		const state = createMutableState({ map, set });
		const heard = record(state);

		transact(state, () => {
			state.map.delete("target");
			state.set.delete("target");
		});

		const ops = heard[0] ?? [];
		const mapIndexPath = ops.find((pair) => pair.do.path[0] === "map" && pair.do.path[1] === "index")?.do.path;
		const setIndexPath = ops.find((pair) => pair.do.path[0] === "set" && pair.do.path[1] === "index")?.do.path;

		expect(mapIndexPath).toEqual(["map", "index", addressOf("target")]);
		expect(setIndexPath).toEqual(["set", "index", addressOf("target")]);
	});

	it("collapses clear-and-rebuild Map membership into one container replace", () => {
		const state = createMutableState({
			map: new TrackedMap([
				["a", 1],
				["b", 2],
			]),
		});
		const heard = record(state);

		transact(state, () => {
			state.map.clear();
			state.map.set("b", 20);
			state.map.set("a", 10);
		});

		const ops = heard[0] ?? [];

		expect(ops).toHaveLength(1);
		expect(ops[0]?.do).toMatchObject({ op: "replace", path: ["map"] });
		expect([...(readValue(ops[0]?.do ?? { op: "remove", path: [] }) as TrackedMap<string, number>)]).toEqual([
			["b", 20],
			["a", 10],
		]);
		replayUndo(state, ops);
		expect([...state.map]).toEqual([
			["a", 1],
			["b", 2],
		]);
		replayDo(state, ops);
		expect([...state.map]).toEqual([
			["b", 20],
			["a", 10],
		]);
	});

	it("collapses multi-slot Set membership edits into one container replace", () => {
		const state = createMutableState({ set: new TrackedSet([1, 2]) });
		const heard = record(state);

		transact(state, () => {
			state.set.delete(1);
			state.set.add(3);
		});

		const ops = heard[0] ?? [];

		expect(ops).toHaveLength(1);
		expect(ops[0]?.do).toMatchObject({ op: "replace", path: ["set"] });
		expect([...(readValue(ops[0]?.do ?? { op: "remove", path: [] }) as TrackedSet<number>)]).toEqual([2, 3]);
		replayUndo(state, ops);
		expect([...state.set]).toEqual([1, 2]);
		replayDo(state, ops);
		expect([...state.set]).toEqual([2, 3]);
	});

	it("emits TrackedDate content at epochMs but replaces a different date target at its parent", () => {
		const state = createMutableState({ retained: new TrackedDate(0), replaced: new TrackedDate(0) });
		const heard = record(state);

		transact(state, () => {
			state.retained.setTime(5);
			state.replaced = new TrackedDate(10);
		});

		expect((heard[0] ?? []).map((pair) => pair.do.path)).toEqual([
			["retained", "epochMs"],
			["replaced"],
		]);
	});

	it("round-trips mixed atomic changes exactly", () => {
		const key = { id: 1 };
		const state = createMutableState({ list: [1, 2], map: new TrackedMap([[key, { count: 1 }]]), set: new TrackedSet(["a"]), date: new TrackedDate(0) });
		const heard = record(state);

		transact(state, () => {
			state.list.length = 4;
			state.list[3] = 9;
			state.map.get(key)!.count = 2;
			state.set.add("b");
			state.date.setTime(10);
		});

		const after = state;
		const ops = heard[0] ?? [];

		replayUndo(state, ops);
		expect(state.list).toEqual([1, 2]);
		expect(state.map.get(key)?.count).toBe(1);
		expect([...state.set]).toEqual(["a"]);
		expect(state.date.getTime()).toBe(0);

		replayDo(state, ops);
		expect(state).toEqual(after);
	});
});

describe("diffSnapshots: container collapse", () => {
	it("mass shrink emits one replace at the array path and round-trips", () => {
		const state = createMutableState({ list: Array.from({ length: 2000 }, (_, index) => index) });
		const heard = record(state);

		transact(state, () => {
			state.list.length = 10;
		});

		const after = state;
		const ops = heard[0] ?? [];

		expect(ops).toHaveLength(1);
		expect(ops[0]?.do).toMatchObject({ op: "replace", path: ["list"] });
		expect(readValue(ops[0]?.do ?? { op: "remove", path: [] })).toEqual(Array.from({ length: 10 }, (_, index) => index));

		replayUndo(state, ops);
		expect(state.list).toEqual(Array.from({ length: 2000 }, (_, index) => index));
		replayDo(state, ops);
		expect(state).toEqual(after);
	});

	it("scattered scalar edits in a large subtree stay atomic", () => {
		const state = createMutableState({
			tree: Array.from({ length: 2000 }, (_, index) => ({ n: index })),
		});
		const heard = record(state);
		const edited = [0, 400, 800, 1200, 1600];

		transact(state, () => {
			for (const index of edited) state.tree[index]!.n = index + 1;
		});

		const ops = heard[0] ?? [];

		expect(ops).toHaveLength(5);
		expect(ops.map((pair) => pair.do)).toEqual(edited.map((index) => ({ op: "replace", path: ["tree", index, "n"], value: index + 1 })));
	});

	it("many small changes beside few huge unchanged entries stay atomic", () => {
		const huge = "x".repeat(50_000);
		const state = createMutableState({
			bag: {
				a: 1,
				b: 2,
				c: 3,
				d: 4,
				e: 5,
				f: 6,
				g: 7,
				h: 8,
				heavy0: huge,
				heavy1: huge,
			},
		});
		const heard = record(state);

		transact(state, () => {
			state.bag.a = 11;
			state.bag.b = 12;
			state.bag.c = 13;
			state.bag.d = 14;
			state.bag.e = 15;
			state.bag.f = 16;
			state.bag.g = 17;
			state.bag.h = 18;
		});

		const ops = heard[0] ?? [];

		expect(ops).toHaveLength(8);
		expect(ops.every((pair) => pair.do.op === "replace" && pair.do.path[0] === "bag" && pair.do.path.length === 2)).toBe(true);
		expect(ops.map((pair) => pair.do.path[1])).toEqual(["a", "b", "c", "d", "e", "f", "g", "h"]);
	});

	it("composes: a container whose children all collapsed can itself collapse", () => {
		const state = createMutableState({
			outer: {
				left: Array.from({ length: 100 }, (_, index) => index),
				right: Array.from({ length: 100 }, (_, index) => index),
			},
		});
		const heard = record(state);

		transact(state, () => {
			state.outer.left.length = 1;
			state.outer.right.length = 1;
		});

		const ops = heard[0] ?? [];

		expect(ops).toHaveLength(1);
		expect(ops[0]?.do).toMatchObject({ op: "replace", path: ["outer"] });
	});

	it("map clear-and-rebuild collapses to one replace with iteration order restored on undo", () => {
		const state = createMutableState({
			map: new TrackedMap([
				["a", 1],
				["b", 2],
				["c", 3],
			]),
		});
		const heard = record(state);

		transact(state, () => {
			state.map.clear();
			state.map.set("c", 30);
			state.map.set("a", 10);
			state.map.set("b", 20);
		});

		const ops = heard[0] ?? [];

		expect(ops).toHaveLength(1);
		expect(ops[0]?.do).toMatchObject({ op: "replace", path: ["map"] });
		expect([...state.map]).toEqual([
			["c", 30],
			["a", 10],
			["b", 20],
		]);

		replayUndo(state, ops);
		expect([...state.map]).toEqual([
			["a", 1],
			["b", 2],
			["c", 3],
		]);
	});

	it("never collapses the root; mass edits collapse only at child paths", () => {
		const before: Record<string, number> = {};
		const after: Record<string, number> = {};

		for (let index = 0; index < 50; index++) {
			before[`k${index}`] = index;
			after[`k${index}`] = index + 1;
		}

		const ops = diffSnapshots(before, after);

		expect(ops.length).toBe(50);
		expect(ops.every((pair) => pair.do.op === "replace" && pair.do.path.length === 1)).toBe(true);
	});

	it("watchdog mass edit reaches the stream as one side-effect container replace", async () => {
		const state = createMutableState({ list: Array.from({ length: 200 }, (_, index) => index) });
		const heard = new Array<{ ops: Array<Op>; meta: unknown }>();

		subscribe(state, (ops, meta) => {
			heard.push({ ops: [...ops], meta });
		});

		state.list.length = 5;

		expect(heard).toHaveLength(0);

		await Promise.resolve();

		expect(heard).toHaveLength(1);
		expect(heard[0]?.meta).toBeUndefined();
		expect(heard[0]?.ops).toHaveLength(1);
		expect(heard[0]?.ops[0]?.do).toMatchObject({ op: "replace", path: ["list"] });
		expect(heard[0]?.ops[0]?.do && "value" in heard[0].ops[0].do ? heard[0].ops[0].do.value : undefined).toEqual([0, 1, 2, 3, 4]);
	});

	it("small-container two-op edit collapses to one replace and round-trips", () => {
		const state = createMutableState({ list: [1, 2, 3] });
		const heard = record(state);

		transact(state, () => {
			state.list[1] = 20;
			state.list[2] = 30;
		});

		const after = state;
		const ops = heard[0] ?? [];

		expect(ops).toHaveLength(1);
		expect(ops[0]?.do).toMatchObject({ op: "replace", path: ["list"] });
		expect(readValue(ops[0]?.do ?? { op: "remove", path: [] })).toEqual([1, 20, 30]);

		replayUndo(state, ops);
		expect(state.list).toEqual([1, 2, 3]);
		replayDo(state, ops);
		expect(state).toEqual(after);
	});

	it("sibling containers straddling the compaction threshold round-trip consistently", () => {
		const bigArray = Array.from({ length: 400 }, (_, index) => index);
		const state = createMutableState({ big: bigArray.slice(), small: { flag: false } });
		const heard = record(state);

		transact(state, () => {
			state.big.length = 5;
			state.small.flag = true;
		});

		const ops = heard[0] ?? [];

		expect(state.big.length).toBe(5);
		expect(state.small.flag).toBe(true);

		replayUndo(state, ops);
		expect(state.big.length).toBe(400);
		expect(state.big[399]).toBe(399);
		expect(state.small.flag).toBe(false);

		replayDo(state, ops);
		expect(state.big.length).toBe(5);
		expect(state.small.flag).toBe(true);
	});
});
