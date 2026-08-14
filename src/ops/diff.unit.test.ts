import { snapshot } from "valtio/vanilla";

import { createMutableState, type MutableStateOptions } from "../createMutableState";
import { isSameIdentity } from "../identity";
import { ignore } from "../ignore";
import { subscribe } from "../subscribe";
import { addressOf } from "../tracked/address";
import { TrackedDate } from "../tracked/trackedDate";
import { TrackedMap } from "../tracked/trackedMap";
import { TrackedSet } from "../tracked/trackedSet";
import { transact } from "../transact";
import { applyOperations } from "./applyOperations";
import { diffObjects } from "./diff";
import {
	createAssignMutation,
	createDeleteMutation,
	createLinkMutation,
	type Mutation,
	type Operation,
} from "./operation";
import { shapeHalf, shapeOps } from "./operationShape";

const rehydrateTransportValue = (value: unknown, memo: WeakMap<object, unknown> = new WeakMap()): unknown => {
	if (value === null || (typeof value !== "object" && typeof value !== "function")) return value;

	const objectValue = value as object;
	const cached = memo.get(objectValue);

	if (cached !== undefined) return cached;

	if (Array.isArray(value)) {
		const copy: Array<unknown> = [];

		memo.set(value, copy);

		for (let index = 0; index < value.length; index++) {
			if (Object.hasOwn(value, index)) copy[index] = rehydrateTransportValue(value[index], memo);
		}

		copy.length = value.length;

		return copy;
	}

	const copy: Record<string, unknown> = {};

	memo.set(objectValue, copy);

	for (const key of Object.keys(objectValue)) {
		if (key === "__proto__") continue;

		const descriptor = Reflect.getOwnPropertyDescriptor(objectValue, key);

		if (descriptor === undefined || !("value" in descriptor)) continue;

		copy[key] = rehydrateTransportValue(descriptor.value, memo);
	}

	return copy;
};

const projectTransport = (ops: ReadonlyArray<Operation>): Array<Operation> =>
	ops.map((pair) => {
		const projectHalf = (half: Mutation): Mutation => {
			if (half.verb === "link") return createLinkMutation([...half.path], [...half.ref]);

			if (half.verb === "delete") return createDeleteMutation([...half.path]);

			return createAssignMutation([...half.path], "value" in half ? rehydrateTransportValue(half.value) : undefined);
		};

		return { do: projectHalf(pair.do), undo: projectHalf(pair.undo) };
	});

const readValue = (operation: Mutation): unknown => ("value" in operation ? operation.value : undefined);

const record = <T extends object>(state: T): Array<Array<Operation>> => {
	const heard = new Array<Array<Operation>>();

	subscribe(state, (ops) => heard.push([...ops]));

	return heard;
};

const replayUndo = <T extends object>(state: T, ops: Array<Operation>): void => applyOperations(state, ops, "undo");
const replayDo = <T extends object>(state: T, ops: Array<Operation>): void => applyOperations(state, ops, "do");

describe("diffObjects: atomic flat paths", () => {
	it("emits addition, change, and removal pairs at frozen array paths", () => {
		const ops = diffObjects({ kept: 1, changed: 2, removed: 3 }, { kept: 1, changed: 4, added: 5 });

		expect(shapeOps(ops)).toEqual([
			{ do: { verb: "assign", path: ["changed"], value: 4 }, undo: { verb: "assign", path: ["changed"], value: 2 } },
			{ do: { verb: "delete", path: ["removed"] }, undo: { verb: "assign", path: ["removed"], value: 3 } },
			{ do: { verb: "assign", path: ["added"], value: 5 }, undo: { verb: "delete", path: ["added"] } },
		]);
		for (const pair of ops) expect(Object.isFrozen(pair.do.path)).toBe(true);
	});

	it("carries added-versus-changed on the undo half, both halves assigning", () => {
		const ops = diffObjects({ changed: 1 }, { changed: 2, added: 3 });
		const change = ops.find((pair) => pair.do.path[0] === "changed");
		const addition = ops.find((pair) => pair.do.path[0] === "added");

		expect(change?.do.verb).toBe("assign");
		expect(addition?.do.verb).toBe("assign");

		expect(change?.undo.verb).toBe("assign");
		expect(readValue(change?.undo ?? { verb: "delete", path: [] })).toBe(1);
		expect(addition?.undo.verb).toBe("delete");
	});

	it("undoes an assignment of undefined onto an absent key with a delete, not a stored undefined", () => {
		const ops = diffObjects({}, { value: undefined } as { value?: number });

		expect(ops).toHaveLength(1);
		expect(ops[0]?.do.verb).toBe("assign");
		expect(readValue(ops[0]?.do ?? { verb: "delete", path: [] })).toBeUndefined();
		expect(ops[0]?.undo.verb).toBe("delete");
	});

	it("recurses only while storage identity is continuous", () => {
		const state = createMutableState({ retained: { count: 1 }, replaced: { count: 1 } });
		const before = snapshot(state);

		transact(state, () => {
			state.retained.count = 2;
			state.replaced = { count: 2 };
		});

		const ops = diffObjects(before, snapshot(state));

		expect(ops.map((pair) => pair.do.path)).toEqual([["retained", "count"], ["replaced"]]);
		expect(readValue(ops[1]?.do ?? { verb: "delete", path: [] })).toEqual({ count: 2 });
	});

	it("compares leaves with Object.is so NaN equals NaN and 0 differs from -0", () => {
		expect(diffObjects({ n: Number.NaN }, { n: Number.NaN })).toEqual([]);
		expect(diffObjects({ z: 0 }, { z: -0 }).map((pair) => shapeHalf(pair.do))).toEqual([
			{ verb: "assign", path: ["z"], value: -0 },
		]);
	});

	it("emits a whole-value assign when equal content lands on a different target", () => {
		const state = createMutableState({ value: { count: 1 } });
		const heard = record(state);
		const before = state.value;

		transact(state, () => {
			state.value = { count: 1 };
		});

		expect(heard[0]).toHaveLength(1);
		expect(heard[0]?.[0]?.do).toMatchObject({ verb: "assign", path: ["value"] });
		expect(isSameIdentity(before, state.value)).toBe(false);
	});

	it("rejects primitive, unsupported, and incompatible roots", () => {
		expect(() => diffObjects(1 as unknown as object, 2 as unknown as object)).toThrow(
			"compatible supported object roots",
		);
		expect(() => diffObjects({}, [])).toThrow("compatible supported object roots");
		expect(() => diffObjects(new Map(), new Map())).toThrow("compatible supported object roots");
	});

	it("accepts plain-data facades as object-container roots", () => {
		const before = new TrackedMap([["a", 1]]);
		const after = new TrackedMap([["a", 2]]);

		expect(() => diffObjects(before, after)).not.toThrow();
	});

	it("emits constructor and prototype as ordinary data rather than rejecting them", () => {
		const before = { h: { constructor: { note: 1 } } };
		const after = { h: { constructor: { note: 1, prototype: { x: 1 } } } };
		const ops = diffObjects(before, after);

		expect(ops.map((op) => op.do.path)).toEqual([["h"]]);

		const [first] = ops;

		if (first === undefined) throw new Error("expected one op");

		const carried = (first.do as { value: { constructor: { prototype: { x: number } } } }).value;

		expect(carried.constructor.prototype.x).toBe(1);
		expect(Object.prototype).not.toHaveProperty("x");

		const hostile = JSON.parse('{"__proto__": {"polluted": true}}') as object;

		expect(diffObjects({}, hostile)).toEqual([]);
		expect(Object.prototype).not.toHaveProperty("polluted");

		const nestedHostile = JSON.parse('{"__proto__": {"polluted": true}, "keep": 2}') as object;

		expect(Object.getOwnPropertyNames(nestedHostile)).toEqual(["__proto__", "keep"]);

		const [sanitized] = diffObjects({}, { a: nestedHostile });

		if (sanitized === undefined) throw new Error("expected one op");

		expect(Object.getOwnPropertyNames((sanitized.do as { value: object }).value)).toEqual(["keep"]);
	});

	it("orders sparse growth length before tail additions and preserves holes", () => {
		const before = [1];
		const after = new Array<unknown>(1);

		after[0] = 1;

		after.length = 4;
		after[3] = undefined;

		const ops = diffObjects(before, after);

		expect(ops.map((pair) => shapeHalf(pair.do))).toEqual([
			{ verb: "assign", path: ["length"], value: 4 },
			{ verb: "assign", path: [3], value: undefined },
		]);
		expect(ops.map((pair) => shapeHalf(pair.undo))).toEqual([
			{ verb: "assign", path: ["length"], value: 1 },
			{ verb: "delete", path: [3] },
		]);
	});

	it("orders truncated removals before shrink and reverse undo expands first", () => {
		const before = [1, 2, 3];
		const after = [1];
		const ops = diffObjects(before, after);

		expect(ops.map((pair) => shapeHalf(pair.do))).toEqual([
			{ verb: "delete", path: [1] },
			{ verb: "delete", path: [2] },
			{ verb: "assign", path: ["length"], value: 1 },
		]);
		expect([...ops].reverse().map((pair) => shapeHalf(pair.undo))).toEqual([
			{ verb: "assign", path: ["length"], value: 3 },
			{ verb: "assign", path: [2], value: 3 },
			{ verb: "assign", path: [1], value: 2 },
		]);
	});

	it("distinguishes holes from stored undefined in overlap", () => {
		const hole = new Array<unknown>(1);
		const stored = [undefined];

		expect(diffObjects(hole, stored)[0]?.do).toEqual({ verb: "assign", path: [0], value: undefined });
		expect(diffObjects(stored, hole)[0]?.do).toEqual({ verb: "delete", path: [0] });
	});

	it("emits enumerable array non-index string properties as ordinary paths", () => {
		const before = [1];
		const after = [1];

		Object.defineProperty(before, "label", { value: "a", enumerable: true });
		Object.defineProperty(after, "label", { value: "b", enumerable: true });

		expect(shapeHalf(diffObjects(before, after)[0]!.do)).toEqual({ verb: "assign", path: ["label"], value: "b" });
	});

	it("mints nothing for a set-only accessor ↔ data transition in either direction", () => {
		const withData = { key: 1 };
		const withAccessor: Record<string, unknown> = {};

		Object.defineProperty(withAccessor, "key", {
			set: () => undefined,
			enumerable: true,
			configurable: true,
		});

		expect(diffObjects(withData, withAccessor)).toEqual([]);
		expect(diffObjects(withAccessor, withData)).toEqual([]);
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

	it("collapses clear-and-rebuild Map membership into one container assign", () => {
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
		expect(ops[0]?.do).toMatchObject({ verb: "assign", path: ["map"] });
		expect([...(readValue(ops[0]?.do ?? { verb: "delete", path: [] }) as TrackedMap<string, number>)]).toEqual([
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

	it("collapses multi-slot Set membership edits into one container assign", () => {
		const state = createMutableState({ set: new TrackedSet([1, 2]) });
		const heard = record(state);

		transact(state, () => {
			state.set.delete(1);
			state.set.add(3);
		});

		const ops = heard[0] ?? [];

		expect(ops).toHaveLength(1);
		expect(ops[0]?.do).toMatchObject({ verb: "assign", path: ["set"] });
		expect([...(readValue(ops[0]?.do ?? { verb: "delete", path: [] }) as TrackedSet<number>)]).toEqual([2, 3]);
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

		expect((heard[0] ?? []).map((pair) => pair.do.path)).toEqual([["retained", "epochMs"], ["replaced"]]);
	});

	it("round-trips mixed atomic changes exactly", () => {
		const key = { id: 1 };
		const state = createMutableState({
			list: [1, 2],
			map: new TrackedMap([[key, { count: 1 }]]),
			set: new TrackedSet(["a"]),
			date: new TrackedDate(0),
		});
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

describe("diffObjects: container collapse", () => {
	it("mass shrink emits one assign at the array path and round-trips", () => {
		const state = createMutableState({ list: Array.from({ length: 2000 }, (_, index) => index) });
		const heard = record(state);

		transact(state, () => {
			state.list.length = 10;
		});

		const after = state;
		const ops = heard[0] ?? [];

		expect(ops).toHaveLength(1);
		expect(ops[0]?.do).toMatchObject({ verb: "assign", path: ["list"] });
		expect(readValue(ops[0]?.do ?? { verb: "delete", path: [] })).toEqual(
			Array.from({ length: 10 }, (_, index) => index),
		);

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
		expect(ops.map((pair) => shapeHalf(pair.do))).toEqual(
			edited.map((index) => ({ verb: "assign", path: ["tree", index, "n"], value: index + 1 })),
		);
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
		expect(
			ops.every((pair) => pair.do.verb === "assign" && pair.do.path[0] === "bag" && pair.do.path.length === 2),
		).toBe(true);
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
		expect(ops[0]?.do).toMatchObject({ verb: "assign", path: ["outer"] });
	});

	it("map clear-and-rebuild collapses to one assign with iteration order restored on undo", () => {
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
		expect(ops[0]?.do).toMatchObject({ verb: "assign", path: ["map"] });
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

		const ops = diffObjects(before, after);

		expect(ops.length).toBe(50);
		expect(ops.every((pair) => pair.do.verb === "assign" && pair.do.path.length === 1)).toBe(true);
	});

	it("bare mass edit reaches the stream as one side-effect container assign", async () => {
		const state = createMutableState({ list: Array.from({ length: 200 }, (_, index) => index) });
		const heard = new Array<{ ops: Array<Operation>; meta: unknown }>();

		subscribe(state, (ops, meta) => {
			heard.push({ ops: [...ops], meta });
		});

		state.list.length = 5;

		expect(heard).toHaveLength(0);

		await Promise.resolve();

		expect(heard).toHaveLength(1);
		expect(heard[0]?.meta).toBeUndefined();
		expect(heard[0]?.ops).toHaveLength(1);
		expect(heard[0]?.ops[0]?.do).toMatchObject({ verb: "assign", path: ["list"] });
		expect(heard[0]?.ops[0]?.do && "value" in heard[0].ops[0].do ? heard[0].ops[0].do.value : undefined).toEqual([
			0, 1, 2, 3, 4,
		]);
	});

	it("small-container two-op edit collapses to one assign and round-trips", () => {
		const state = createMutableState({ list: [1, 2, 3] });
		const heard = record(state);

		transact(state, () => {
			state.list[1] = 20;
			state.list[2] = 30;
		});

		const after = state;
		const ops = heard[0] ?? [];

		expect(ops).toHaveLength(1);
		expect(ops[0]?.do).toMatchObject({ verb: "assign", path: ["list"] });
		expect(readValue(ops[0]?.do ?? { verb: "delete", path: [] })).toEqual([1, 20, 30]);

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

	it("round-trips wholesale-array growth, shrink, and sparse holes through collapse", () => {
		const shrinkState = createMutableState({ list: Array.from({ length: 2000 }, (_, index) => index) });
		const shrinkHeard = record(shrinkState);

		transact(shrinkState, () => {
			shrinkState.list.length = 10;
		});

		const shrinkOps = shrinkHeard[0] ?? [];

		expect(shrinkOps).toHaveLength(1);
		expect(shrinkOps[0]?.do).toMatchObject({ verb: "assign", path: ["list"] });
		replayUndo(shrinkState, shrinkOps);
		expect(shrinkState.list).toEqual(Array.from({ length: 2000 }, (_, index) => index));
		replayDo(shrinkState, shrinkOps);
		expect(shrinkState.list).toEqual(Array.from({ length: 10 }, (_, index) => index));

		const growthState = createMutableState({ list: Array.from({ length: 10 }, (_, index) => index) });
		const growthHeard = record(growthState);

		transact(growthState, () => {
			for (let index = 10; index < 2000; index++) growthState.list[index] = index;
		});

		const growthOps = growthHeard[0] ?? [];

		expect(growthOps).toHaveLength(1);
		expect(growthOps[0]?.do).toMatchObject({ verb: "assign", path: ["list"] });
		replayUndo(growthState, growthOps);
		expect(growthState.list).toEqual(Array.from({ length: 10 }, (_, index) => index));
		replayDo(growthState, growthOps);
		expect(growthState.list).toEqual(Array.from({ length: 2000 }, (_, index) => index));

		const sparseState = createMutableState({ list: Array.from({ length: 2000 }, (_, index) => index) });
		const sparseHeard = record(sparseState);

		transact(sparseState, () => {
			for (let index = 0; index < 2000; index += 2) delete sparseState.list[index];
			sparseState.list.length = 1800;
		});

		const sparseOps = sparseHeard[0] ?? [];

		expect(sparseOps).toHaveLength(1);
		expect(sparseOps[0]?.do).toMatchObject({ verb: "assign", path: ["list"] });

		replayUndo(sparseState, sparseOps);
		expect(sparseState.list).toEqual(Array.from({ length: 2000 }, (_, index) => index));
		replayDo(sparseState, sparseOps);
		expect(sparseState.list).toHaveLength(1800);

		const survivingOdds = Array.from({ length: 900 }, (_, index) => sparseState.list[index * 2 + 1]);
		const evenPresence = Array.from({ length: 900 }, (_, index) => Object.hasOwn(sparseState.list, index * 2));

		expect(survivingOdds).toEqual(Array.from({ length: 900 }, (_, index) => index * 2 + 1));
		expect(evenPresence).toEqual(Array.from({ length: 900 }, () => false));
	});
});

interface Formation {
	readonly name: string;
	readonly expectedDo: {
		readonly verb: string;
		readonly path: ReadonlyArray<string | number>;
		readonly ref?: ReadonlyArray<string | number>;
	};
	readonly start: () => { readonly state: object; readonly form: () => void; readonly assertFormed: () => void };
}

const rideAlongBackEdges: ReadonlyArray<readonly [string, () => object]> = [
	[
		"a non-enumerable back-edge",
		() => {
			const node = { m: 1 };

			Object.defineProperty(node, "hidden", { value: node, enumerable: false, writable: true, configurable: true });

			return node;
		},
	],
	[
		"a symbol-keyed back-edge",
		() => {
			const node: { m: number; [key: symbol]: unknown } = { m: 1 };

			node[Symbol("back")] = node;

			return node;
		},
	],
];

const buildAliasedDiamond = (levels: number): object => {
	let node: object = { leaf: 1 };

	for (let level = 0; level < levels; level++) node = { left: node, right: node };

	return node;
};

const pathOf = (ops: ReadonlyArray<Operation> | undefined): Array<ReadonlyArray<string | number>> =>
	(ops ?? []).map((pair) => [...pair.do.path]);

describe("diffObjects: cyclic values", () => {
	const formations: ReadonlyArray<Formation> = [
		{
			name: "a child self-cycle",
			expectedDo: { verb: "link", path: ["box", "self"], ref: ["box"] },
			start: () => {
				const state = createMutableState<{ box: { n: number; self?: object } }>({ box: { n: 1 } });

				return {
					state,
					form: () => {
						state.box.self = state.box;
					},
					assertFormed: () => {
						expect(state.box.self).toBe(state.box);
					},
				};
			},
		},
		{
			name: "a wholesale cyclic object",
			expectedDo: { verb: "assign", path: ["node"] },
			start: () => {
				const state = createMutableState<{ n: number; node?: { m: number; self?: object } }>({ n: 1 });

				return {
					state,
					form: () => {
						const node: { m: number; self?: object } = { m: 1 };

						node.self = node;
						state.node = node;
					},
					assertFormed: () => {
						expect(state.node?.self).toBe(state.node);
					},
				};
			},
		},
		{
			name: "a two-node cycle",
			expectedDo: { verb: "link", path: ["a", "peer"], ref: ["b"] },
			start: () => {
				const state = createMutableState<{ a: { n: number; peer?: object }; b: { n: number; peer?: object } }>({
					a: { n: 1 },
					b: { n: 2 },
				});

				return {
					state,
					form: () => {
						state.a.peer = state.b;
						state.b.peer = state.a;
					},
					assertFormed: () => {
						expect(state.a.peer).toBe(state.b);
						expect(state.b.peer).toBe(state.a);
					},
				};
			},
		},
	];

	it("mints a self-cycle as a link with an empty ref", () => {
		const state = createMutableState<{ n: number; self?: object }>({ n: 1 });
		const heard = record(state);

		transact(state, () => {
			state.self = state;
		});

		expect(heard).toHaveLength(1);
		expect(heard[0]?.[0]?.do).toMatchObject({ verb: "link", path: ["self"], ref: [] });
		expect(state.self).toBe(state);

		const delivered = heard[0] ?? [];
		const replica = createMutableState<{ n: number; self?: object }>({ n: 1 });

		expect(() => applyOperations(replica, projectTransport(delivered), "do")).not.toThrow();
		expect(replica.self).toBe(replica);

		replayUndo(state, delivered);
		expect(state.self).toBeUndefined();

		replayDo(state, delivered);
		expect(state.self).toBe(state);
	});

	it("mints a back-edge to the factory return as a link with an empty ref", () => {
		const state = createMutableState<{ child: { n: number; back?: object } }>({ child: { n: 1 } });
		const heard = record(state);

		transact(state, () => {
			state.child.back = state;
		});

		expect(heard).toHaveLength(1);
		expect(heard[0]?.[0]?.do).toMatchObject({ verb: "link", path: ["child", "back"], ref: [] });
		expect(state.child.back).toBe(state);

		const delivered = heard[0] ?? [];
		const replica = createMutableState<{ child: { n: number; back?: object } }>({ child: { n: 1 } });

		expect(() => applyOperations(replica, projectTransport(delivered), "do")).not.toThrow();
		expect(replica.child.back).toBe(replica);

		replayUndo(state, delivered);
		expect(state.child.back).toBeUndefined();

		replayDo(state, delivered);
		expect(state.child.back).toBe(state);
	});

	it.each(formations.map((formation) => [formation.name, formation] as const))(
		"delivers a link or value op forming %s and round-trips undo/do",
		(_name, formation) => {
			const { state, form, assertFormed } = formation.start();
			const heard = record(state);

			transact(state, form);

			expect(heard).toHaveLength(1);
			expect(heard[0]?.[0]?.do).toMatchObject(formation.expectedDo);
			if (formation.name === "a wholesale cyclic object") {
				expect(shapeOps(heard[0] ?? [])).toEqual([
					{ do: { verb: "assign", path: ["node"], value: {} }, undo: { verb: "delete", path: ["node"] } },
					{ do: { verb: "assign", path: ["node", "m"], value: 1 }, undo: { verb: "delete", path: ["node", "m"] } },
					{
						do: { verb: "link", path: ["node", "self"], ref: ["node"] },
						undo: { verb: "delete", path: ["node", "self"] },
					},
				]);
			}
			assertFormed();

			const delivered = heard[0] ?? [];

			const replicaSession = formation.start();

			expect(() => applyOperations(replicaSession.state, projectTransport(delivered), "do")).not.toThrow();
			replicaSession.assertFormed();

			replayUndo(state, delivered);
			replayDo(state, delivered);
			assertFormed();
		},
	);

	it("delivers a bare cyclic formation without throwing", async () => {
		const thrown = new Array<unknown>();
		const emitOn = (flush: () => void): void => {
			try {
				flush();
			} catch (error) {
				thrown.push(error);
			}
		};
		const state = createMutableState<{ box: { n: number; self?: object } }>({ box: { n: 1 } }, { emitOn });
		const heard = record(state);

		state.box.self = state.box;

		await Promise.resolve();
		await Promise.resolve();

		expect(thrown).toHaveLength(0);
		expect(heard).toHaveLength(1);
		expect(heard[0]?.[0]?.do).toMatchObject({ verb: "link", path: ["box", "self"], ref: ["box"] });
		expect(state.box.self).toBe(state.box);
	});

	it("diffs a latent cycle under an unrelated mass edit without throwing", () => {
		interface Holder {
			holder: {
				cycle: { n: number; self?: object };
				a: number;
				b: number;
				c: number;
				d: number;
				e: number;
			};
		}

		const state = createMutableState<Holder>({ holder: { cycle: { n: 1 }, a: 1, b: 2, c: 3, d: 4, e: 5 } });

		state.holder.cycle.self = state.holder.cycle;

		const heard = record(state);

		transact(state, () => {
			state.holder.a = 10;
			state.holder.b = 20;
			state.holder.c = 30;
			state.holder.d = 40;
			state.holder.e = 50;
		});

		expect(heard).toHaveLength(1);
		expect(pathOf(heard[0])).toEqual([
			["holder", "a"],
			["holder", "b"],
			["holder", "c"],
			["holder", "d"],
			["holder", "e"],
		]);
		expect(state.holder.a).toBe(10);
		expect(state.holder.cycle.self).toBe(state.holder.cycle);
	});

	const startRepair = (
		options?: MutableStateOptions,
	): { state: { box: { n: number; self?: object } }; repair: () => void } => {
		const state = createMutableState<{ box: { n: number; self?: object } }>({ box: { n: 1 } }, options);

		state.box.self = state.box;

		return {
			state,
			repair: () => {
				delete state.box.self;
			},
		};
	};

	it("repairs a cycle with a delete whose undo link restores the cycle by identity", () => {
		const { state, repair } = startRepair();
		const heard = record(state);

		transact(state, repair);

		expect(heard).toHaveLength(1);
		expect(heard[0]).toHaveLength(1);
		expect(heard[0]?.[0]?.do).toMatchObject({ verb: "delete", path: ["box", "self"] });
		expect(heard[0]?.[0]?.undo).toMatchObject({ verb: "link", path: ["box", "self"], ref: ["box"] });
		expect(state.box.self).toBeUndefined();

		const delivered = heard[0] ?? [];

		replayUndo(state, delivered);
		expect(state.box.self).toBe(state.box);

		replayDo(state, delivered);
		expect(state.box.self).toBeUndefined();
	});

	it("repairs a cycle on the bare lane without throwing", async () => {
		const thrown = new Array<unknown>();
		const emitOn = (flush: () => void): void => {
			try {
				flush();
			} catch (error) {
				thrown.push(error);
			}
		};
		const { state, repair } = startRepair({ emitOn });
		const heard = record(state);

		repair();

		await Promise.resolve();
		await Promise.resolve();

		expect(thrown).toHaveLength(0);
		expect(heard).toHaveLength(1);
		expect(heard[0]?.[0]?.do).toMatchObject({ verb: "delete", path: ["box", "self"] });
	});

	it("rolls back a throwing callback over a cyclic baseline with no cause and restores the cycle", async () => {
		const thrown = new Array<unknown>();
		const emitOn = (flush: () => void): void => {
			try {
				flush();
			} catch (error) {
				thrown.push(error);
			}
		};
		const state = createMutableState<{ box: { n: number; self?: object } }>({ box: { n: 1 } }, { emitOn });

		state.box.self = state.box;

		subscribe(state, () => undefined);

		const callbackError = new Error("callback failed");
		let caught: unknown;

		try {
			transact(state, () => {
				state.box.n = 99;

				throw callbackError;
			});
		} catch (error) {
			caught = error;
		}

		expect(caught).toBe(callbackError);
		expect((caught as Error).cause).toBeUndefined();
		expect(state.box.n).toBe(1);
		expect(state.box.self).toBe(state.box);

		await Promise.resolve();
		await Promise.resolve();

		expect(thrown).toHaveLength(0);
	});

	it("rolls back a throwing cycle-repairing transaction and restores the cycle", async () => {
		const thrown = new Array<unknown>();
		const emitOn = (flush: () => void): void => {
			try {
				flush();
			} catch (error) {
				thrown.push(error);
			}
		};
		const state = createMutableState<{ box: { n: number; self?: object } }>({ box: { n: 1 } }, { emitOn });

		state.box.self = state.box;

		subscribe(state, () => undefined);

		const callbackError = new Error("callback failed");
		let caught: unknown;

		try {
			transact(state, () => {
				delete state.box.self;

				throw callbackError;
			});
		} catch (error) {
			caught = error;
		}

		expect(caught).toBe(callbackError);
		expect((caught as Error).cause).toBeUndefined();
		expect(state.box.self).toBe(state.box);

		await Promise.resolve();
		await Promise.resolve();

		expect(thrown).toHaveLength(0);
	});

	it("rolls back a cycle formed then thrown, emits nothing, and raises no unhandled rejection", async () => {
		const thrown = new Array<unknown>();
		const emitOn = (flush: () => void): void => {
			try {
				flush();
			} catch (error) {
				thrown.push(error);
			}
		};
		const state = createMutableState<{ box: { n: number; self?: object } }>({ box: { n: 1 } }, { emitOn });
		const heard = record(state);
		const callbackError = new Error("callback failed");
		let caught: unknown;

		try {
			transact(state, () => {
				state.box.self = state.box;

				throw callbackError;
			});
		} catch (error) {
			caught = error;
		}

		expect(caught).toBe(callbackError);
		expect((caught as Error).cause).toBeUndefined();
		expect(state.box.self).toBeUndefined();
		expect(heard).toHaveLength(0);

		await Promise.resolve();
		await Promise.resolve();

		expect(thrown).toHaveLength(0);
		expect(heard).toHaveLength(0);
	});

	it.each(rideAlongBackEdges)("carries %s at the assign path without throwing", (_name, create) => {
		const state = createMutableState<{ n: number; node?: object }>({ n: 1 });
		const heard = record(state);

		transact(state, () => {
			state.node = create();
		});

		expect(heard).toHaveLength(1);
		expect(heard[0]?.[0]?.do).toMatchObject({ verb: "assign", path: ["node"] });
		expect(() => readValue(heard[0]?.[0]?.do ?? { verb: "delete", path: [] })).not.toThrow();
	});

	it("mints one op per route for a k=2 aliased interior change", () => {
		const shared = { n: 1 };
		const state = createMutableState<{ a: { b: { n: number } }; b: { n: number } }>({
			a: { b: shared },
			b: shared,
		});
		const heard = record(state);

		transact(state, () => {
			state.a.b.n = 5;
		});

		expect(pathOf(heard[0])).toEqual([
			["a", "b", "n"],
			["b", "n"],
		]);
		expect(state.a.b).toBe(state.b);
		expect(state.a.b.n).toBe(5);
	});

	it("mints one op per route for a k=3 aliased interior change", () => {
		const shared = { n: 1 };
		const state = createMutableState<{ a: { b: { n: number } }; b: { n: number }; c: { n: number } }>({
			a: { b: shared },
			b: shared,
			c: shared,
		});
		const heard = record(state);

		transact(state, () => {
			state.a.b.n = 7;
		});

		expect(pathOf(heard[0])).toEqual([
			["a", "b", "n"],
			["b", "n"],
			["c", "n"],
		]);
		expect(state.a.b.n).toBe(7);
		expect(state.b.n).toBe(7);
		expect(state.c.n).toBe(7);
	});

	it("mints a link for alias formation so a replica preserves sharing", () => {
		const shared = { n: 1 };
		const state = createMutableState<{ a: { b: { n: number } }; b: { n: number }; b2?: { n: number } }>({
			a: { b: shared },
			b: shared,
		});
		const heard = record(state);

		transact(state, () => {
			state.b2 = state.a.b;
		});

		expect(heard[0]?.[0]?.do).toMatchObject({ verb: "link", path: ["b2"], ref: ["a", "b"] });
		expect(state.b2).toBe(state.a.b);

		const replicaShared = { n: 1 };
		const replica = createMutableState<{ a: { b: { n: number } }; b: { n: number }; b2?: { n: number } }>({
			a: { b: replicaShared },
			b: replicaShared,
		});

		applyOperations(replica, projectTransport(heard[0] ?? []), "do");
		expect(replica.b2).toBe(replica.a.b);
		expect(replica.b2).toBe(replica.b);
	});

	it("restores an interior cycle with a link on a replica", () => {
		const state = createMutableState<{ box: { n: number; self?: object } }>({ box: { n: 1 } });
		const heard = record(state);

		transact(state, () => {
			state.box.self = state.box;
		});

		const replica = createMutableState<{ box: { n: number; self?: object } }>({ box: { n: 1 } });

		applyOperations(replica, projectTransport(heard[0] ?? []), "do");
		expect(replica.box.self).toBe(replica.box);
	});

	it("mints a link undo for a delete of one route to a still-referenced node", () => {
		const shared = { n: 1 };
		const state = createMutableState<{ a: { b: { n: number } }; b?: { n: number } }>({
			a: { b: shared },
			b: shared,
		});
		const heard = record(state);

		transact(state, () => {
			delete state.b;
		});

		expect(heard[0]?.[0]?.do).toMatchObject({ verb: "delete", path: ["b"] });
		expect(heard[0]?.[0]?.undo).toMatchObject({ verb: "link", path: ["b"], ref: ["a", "b"] });
		expect(state.b).toBeUndefined();
		expect(state.a.b.n).toBe(1);

		replayUndo(state, heard[0] ?? []);
		expect(state.b).toBe(state.a.b);
	});

	it("mints a link undo for a nested multi-route delete at the formation route", () => {
		const shared = { n: 1 };
		const state = createMutableState<{
			outer: { a: { x: { n: number } }; b: { y?: { n: number } } };
		}>({
			outer: { a: { x: shared }, b: { y: shared } },
		});
		const heard = record(state);

		transact(state, () => {
			delete state.outer.b.y;
		});

		expect(pathOf(heard[0])).toEqual([["outer", "b", "y"]]);
		expect(heard[0]?.[0]?.undo).toMatchObject({
			verb: "link",
			path: ["outer", "b", "y"],
			ref: ["outer", "a", "x"],
		});
		expect(state.outer.b.y).toBeUndefined();
		expect(state.outer.a.x.n).toBe(1);

		replayUndo(state, heard[0] ?? []);
		expect(state.outer.b.y).toBe(state.outer.a.x);
	});

	it("mints tree-shaped atomic ops for a tree-shaped state", () => {
		const state = createMutableState({ a: { b: { c: 1 } }, d: 2 });
		const heard = record(state);

		transact(state, () => {
			state.a.b.c = 9;
			state.d = 3;
		});

		expect(pathOf(heard[0])).toEqual([["a", "b", "c"], ["d"]]);
	});

	it("mints links for two independent sibling cycles at their formation routes", () => {
		const state = createMutableState<{
			left: { n: number; self?: object };
			right: { n: number; self?: object };
		}>({ left: { n: 1 }, right: { n: 2 } });
		const heard = record(state);

		transact(state, () => {
			state.left.self = state.left;
			state.right.self = state.right;
		});

		expect(shapeOps(heard[0] ?? [])).toEqual([
			{
				do: { verb: "link", path: ["left", "self"], ref: ["left"] },
				undo: { verb: "delete", path: ["left", "self"] },
			},
			{
				do: { verb: "link", path: ["right", "self"], ref: ["right"] },
				undo: { verb: "delete", path: ["right", "self"] },
			},
		]);
		expect(state.left.self).toBe(state.left);
		expect(state.right.self).toBe(state.right);
	});

	it("assigns a symbol-keyed carrier with value carriage (symbol edges stay ride-along)", () => {
		const external = { marker: 1 };
		const state = createMutableState<{
			held: { marker: number };
			carrier?: { [key: symbol]: object };
		}>({ held: external });
		const symbolKey = Symbol("ride");
		const heard = record(state);

		transact(state, () => {
			const carrier: { [key: symbol]: object } = {};

			carrier[symbolKey] = state.held;
			state.carrier = carrier;
		});

		expect(heard).toHaveLength(1);
		expect(heard[0]?.[0]?.do.verb).toBe("assign");
		expect(state.carrier?.[symbolKey]).toBe(state.held);
	});

	it("accepts identity-rewiring of bisimilar self-cycles as a closed identity discontinuity", () => {
		const state = createMutableState<{ a: { self?: object } }>({ a: {} });

		state.a.self = state.a;

		const heard = record(state);

		transact(state, () => {
			const copy: { self?: object } = {};

			copy.self = copy;
			state.a.self = copy;
		});

		expect(heard).toHaveLength(1);
		expect(heard[0]).toHaveLength(2);
		expect(heard[0]?.[0]?.do).toMatchObject({ verb: "assign", path: ["a", "self"], value: {} });
		expect(heard[0]?.[1]?.do).toMatchObject({ verb: "link", path: ["a", "self", "self"], ref: ["a", "self"] });
		expect(() => readValue(heard[0]?.[0]?.do ?? { verb: "delete", path: [] })).not.toThrow();
		expect(state.a.self).toBeDefined();
		expect((state.a.self as { self?: object }).self).toBe(state.a.self);
	});

	it("diffs a deeply aliased diamond, walking each shared subgraph once", () => {
		const state = createMutableState<{ n: number; diamond?: object }>({ n: 1 });
		const heard = record(state);

		transact(state, () => {
			state.diamond = buildAliasedDiamond(64);
		});

		expect(heard[0]!.length).toBeGreaterThan(1);
		expect(heard[0]!.length).toBeLessThan(200);
		expect((heard[0] ?? []).some((pair) => pair.do.verb === "link")).toBe(true);
		expect(() => JSON.stringify(heard[0])).not.toThrow();

		const replica = createMutableState<{ n: number; diamond?: object }>({ n: 1 });

		applyOperations(replica, projectTransport(heard[0] ?? []), "do");

		const root = replica.diamond as { left: object; right: object };

		expect(root.left).toBe(root.right);

		let current = root.left as { left: object; right: object };

		for (let step = 0; step < 3; step++) {
			expect(current.left).toBe(current.right);
			current = current.left as { left: object; right: object };
		}
	});

	it("decomposes a fresh self-cycle so the assign payload is a tree", () => {
		const state = createMutableState<{ n: number; node?: { m: number; self?: object } }>({ n: 1 });
		const heard = record(state);

		transact(state, () => {
			const node: { m: number; self?: object } = { m: 1 };

			node.self = node;
			state.node = node;
		});

		expect(shapeOps(heard[0] ?? [])).toEqual([
			{ do: { verb: "assign", path: ["node"], value: {} }, undo: { verb: "delete", path: ["node"] } },
			{ do: { verb: "assign", path: ["node", "m"], value: 1 }, undo: { verb: "delete", path: ["node", "m"] } },
			{
				do: { verb: "link", path: ["node", "self"], ref: ["node"] },
				undo: { verb: "delete", path: ["node", "self"] },
			},
		]);
	});

	it("decomposes a last-route delete of a cyclic node", () => {
		const state = createMutableState<{ n: number; node?: { m: number; self?: object } }>({ n: 1 });

		transact(state, () => {
			const node: { m: number; self?: object } = { m: 1 };

			node.self = node;
			state.node = node;
		});

		const heard = record(state);

		transact(state, () => {
			delete state.node;
		});

		expect(shapeOps(heard[0] ?? [])).toEqual([
			{ do: { verb: "delete", path: ["node", "m"] }, undo: { verb: "assign", path: ["node", "m"], value: 1 } },
			{
				do: { verb: "delete", path: ["node", "self"] },
				undo: { verb: "link", path: ["node", "self"], ref: ["node"] },
			},
			{ do: { verb: "delete", path: ["node"] }, undo: { verb: "assign", path: ["node"], value: {} } },
		]);

		applyOperations(state, heard[0] ?? [], "undo");
		expect(state.node?.self).toBe(state.node);
	});

	it("decomposes a last-route delete of an aliased diamond", () => {
		const state = createMutableState<{ n: number; node?: { left: { n: number }; right: { n: number } } }>({ n: 1 });

		transact(state, () => {
			const shared = { n: 1 };

			state.node = { left: shared, right: shared };
		});

		const heard = record(state);

		transact(state, () => {
			delete state.node;
		});

		expect(shapeOps(heard[0] ?? [])).toEqual([
			{
				do: { verb: "delete", path: ["node", "right"] },
				undo: { verb: "link", path: ["node", "right"], ref: ["node", "left"] },
			},
			{
				do: { verb: "delete", path: ["node", "left"] },
				undo: { verb: "assign", path: ["node", "left"], value: { n: 1 } },
			},
			{ do: { verb: "delete", path: ["node"] }, undo: { verb: "assign", path: ["node"], value: {} } },
		]);

		applyOperations(state, heard[0] ?? [], "undo");
		expect(state.node?.left).toBe(state.node?.right);
	});

	it("deletes two of three aliases and undoes onto the survivor", () => {
		const shared = { n: 1 };
		const state = createMutableState<{ a?: { n: number }; b?: { n: number }; c: { n: number } }>({
			a: shared,
			b: shared,
			c: shared,
		});
		const heard = record(state);

		transact(state, () => {
			delete state.a;
			delete state.b;
		});

		applyOperations(state, heard[0] ?? [], "undo");
		expect(state.a).toBe(state.b);
		expect(state.b).toBe(state.c);
	});

	it("preserves sharing across a JSON round trip of a formation batch", () => {
		const shared = { n: 1 };
		const state = createMutableState<{ a: { n: number }; b?: { n: number } }>({ a: shared });
		const heard = record(state);

		transact(state, () => {
			state.b = state.a;
		});

		const wire = JSON.stringify(shapeOps(heard[0] ?? []));
		const revived = (
			JSON.parse(wire) as Array<{ do: ReturnType<typeof shapeHalf>; undo: ReturnType<typeof shapeHalf> }>
		).map((pair) => {
			const project = (half: ReturnType<typeof shapeHalf>): Mutation => {
				if (half.verb === "link") return createLinkMutation(half.path, half.ref ?? []);

				if (half.verb === "delete") return createDeleteMutation(half.path);

				return createAssignMutation(half.path, half.value);
			};

			return { do: project(pair.do), undo: project(pair.undo) };
		});
		const replica = createMutableState<{ a: { n: number }; b?: { n: number } }>({ a: { n: 1 } });

		applyOperations(replica, revived, "do");
		expect(replica.b).toBe(replica.a);
	});

	it("mints a link undo for an init-time alias overwrite", () => {
		const shared = { n: 1 };
		const state = createMutableState<{ a: { n: number }; b: { n: number }; alias: { n: number } }>({
			a: shared,
			b: { n: 2 },
			alias: shared,
		});
		const heard = record(state);

		transact(state, () => {
			state.alias = state.b;
		});

		const overwrite = heard[0] ?? [];

		expect(overwrite[0]?.do).toMatchObject({ verb: "link", path: ["alias"], ref: ["b"] });
		expect(overwrite[0]?.undo).toMatchObject({ verb: "link", path: ["alias"], ref: ["a"] });

		replayUndo(state, overwrite);
		expect(state.alias).toBe(state.a);

		replayDo(state, overwrite);
		expect(state.alias).toBe(state.b);
	});

	it("mints a link undo for a cross-tick alias overwrite", async () => {
		const state = createMutableState<{ a: { n: number }; b: { n: number }; alias?: { n: number } }>({
			a: { n: 1 },
			b: { n: 2 },
		});
		const heard = record(state);

		transact(state, () => {
			state.alias = state.a;
		});

		await Promise.resolve();
		await Promise.resolve();

		transact(state, () => {
			state.alias = state.b;
		});

		const overwrite = heard[1] ?? [];

		expect(overwrite[0]?.do).toMatchObject({ verb: "link", path: ["alias"], ref: ["b"] });
		expect(overwrite[0]?.undo).toMatchObject({ verb: "link", path: ["alias"], ref: ["a"] });

		replayUndo(state, overwrite);
		expect(state.alias).toBe(state.a);

		replayDo(state, overwrite);
		expect(state.alias).toBe(state.b);
	});

	it("mints a deferred emitOn alias formation as a link when another state flushes first", async () => {
		const deferred: Array<() => void> = [];
		const emitOn = (flush: () => void): void => {
			deferred.push(flush);
		};
		const shared = { n: 1 };
		const stateA = createMutableState<{ held: { n: number }; alias?: { n: number } }>({ held: shared }, { emitOn });
		const stateB = createMutableState<{ count: number }>({ count: 0 });
		const heardA = record(stateA);
		const heardB = record(stateB);

		stateA.alias = stateA.held;
		stateB.count = 1;

		await Promise.resolve();
		await Promise.resolve();

		expect(heardB).toHaveLength(1);
		expect(heardA).toHaveLength(0);

		for (const flush of deferred) flush();

		expect(heardA).toHaveLength(1);
		expect(heardA[0]?.[0]?.do).toMatchObject({ verb: "link", path: ["alias"], ref: ["held"] });
		expect(stateA.alias).toBe(stateA.held);
	});

	it("decomposes a fresh carrier with an escaping key so the link sits at its key position", () => {
		const shared = { n: 1 };
		const state = createMutableState<{
			shared: { n: number };
			carrier?: { x: number; y: { n: number }; z: number };
		}>({ shared });
		const heard = record(state);

		transact(state, () => {
			state.carrier = { x: 1, y: state.shared, z: 2 };
		});

		expect(shapeOps(heard[0] ?? [])).toEqual([
			{
				do: { verb: "assign", path: ["carrier"], value: {} },
				undo: { verb: "delete", path: ["carrier"] },
			},
			{
				do: { verb: "assign", path: ["carrier", "x"], value: 1 },
				undo: { verb: "delete", path: ["carrier", "x"] },
			},
			{
				do: { verb: "link", path: ["carrier", "y"], ref: ["shared"] },
				undo: { verb: "delete", path: ["carrier", "y"] },
			},
			{
				do: { verb: "assign", path: ["carrier", "z"], value: 2 },
				undo: { verb: "delete", path: ["carrier", "z"] },
			},
		]);
		expect(state.carrier?.y).toBe(state.shared);
	});

	it("mints a link for a moved subtree's interior alias", () => {
		const shared = { n: 1 };
		const state = createMutableState<{
			shared: { n: number };
			from?: { inner: { n: number }; tag: number };
			to?: { inner: { n: number }; tag: number };
		}>({ shared, from: { inner: shared, tag: 1 } });
		const heard = record(state);

		transact(state, () => {
			state.to = state.from;
			delete state.from;
		});

		const ops = heard[0] ?? [];
		const link = ops.find((pair) => pair.do.verb === "link");

		expect(link?.do).toMatchObject({ verb: "link" });
		expect(state.to?.inner).toBe(state.shared);
		expect(state.from).toBeUndefined();
	});

	it("mints a facade slot link across TrackedMap set and delete", () => {
		const shared = { n: 1 };
		const state = createMutableState({
			shared,
			map: new TrackedMap<string, { n: number }>(),
		});
		const heard = record(state);

		transact(state, () => {
			state.map.set("k", state.shared);
		});

		const formation = heard[0] ?? [];
		const link = formation.find((pair) => pair.do.verb === "link");

		expect(link?.do.verb).toBe("link");
		expect(link?.do).toMatchObject({ verb: "link", ref: ["shared"] });
		expect(state.map.get("k")).toBe(state.shared);

		transact(state, () => {
			state.map.delete("k");
		});

		const removal = heard[1] ?? [];

		expect(removal.length).toBeGreaterThan(0);
		expect(state.map.has("k")).toBe(false);

		replayUndo(state, removal);
		expect(state.map.get("k")).toBe(state.shared);

		replayDo(state, removal);
		expect(state.map.has("k")).toBe(false);
	});
});

describe("diffObjects: link batch construction", () => {
	it("carries the value at the canonical route and links the rest when both routes are new", () => {
		const state = createMutableState<{ late?: { n: number }; early?: { n: number } }>({});
		const heard = record(state);

		transact(state, () => {
			state.late = { n: 1 };
			state.early = state.late;
		});

		const delivered = heard[0] ?? [];

		expect(delivered).toHaveLength(2);
		expect(shapeOps(delivered)[0]?.do).toMatchObject({ verb: "assign", path: ["late"] });
		expect(shapeOps(delivered)[1]?.do).toEqual({ verb: "link", path: ["early"], ref: ["late"] });

		const replica = createMutableState<{ late?: { n: number }; early?: { n: number } }>({});

		applyOperations(replica, projectTransport(delivered), "do");

		expect(replica.late).toEqual({ n: 1 });
		expect(replica.early).toBe(replica.late);
	});

	it("prefers a route that predates the batch over a route the batch mints", () => {
		const state = createMutableState<{ hub: { n: number }; a?: object; b?: object }>({ hub: { n: 1 } });
		const heard = record(state);

		transact(state, () => {
			state.a = state.hub;
			state.b = state.hub;
		});

		for (const pair of shapeOps(heard[0] ?? [])) expect(pair.do).toMatchObject({ verb: "link", ref: ["hub"] });
	});

	it("keeps a value undo when the surviving route is torn down earlier in the undo direction", () => {
		const state = createMutableState<{ a?: { n: number }; b?: { n: number } }>({ a: { n: 1 } });
		const heard = record(state);

		transact(state, () => {
			const node = state.a;

			delete state.a;
			state.b = node;
		});

		const delivered = heard[0] ?? [];

		applyOperations(state, delivered, "undo");

		expect(state.a).toEqual({ n: 1 });
		expect(state).not.toHaveProperty("b");
	});

	it("restores the baseline when a transaction forming a move throws", () => {
		const state = createMutableState<{ from?: { deep: { n: number } }; to?: { deep: { n: number } } }>({
			from: { deep: { n: 1 } },
		});

		record(state);

		expect(() =>
			transact(state, () => {
				state.to = state.from;

				delete state.from;

				throw new Error("boom");
			}),
		).toThrow("boom");

		expect(state.from).toEqual({ deep: { n: 1 } });
		expect(state).not.toHaveProperty("to");
	});

	it("mints a numeric ref segment through an array index and resolves it on a replica", () => {
		const state = createMutableState<{ list: Array<{ n: number }>; slot?: { n: number } }>({ list: [{ n: 1 }] });
		const heard = record(state);

		transact(state, () => {
			state.slot = state.list[0];
		});

		const delivered = heard[0] ?? [];
		const half = delivered[0]?.do;

		if (half?.verb !== "link") throw new Error("expected a link half");

		expect([...half.path]).toEqual(["slot"]);
		expect([...half.ref]).toEqual(["list", 0]);
		expect(typeof half.ref[1]).toBe("number");

		const replica = createMutableState<{ list: Array<{ n: number }>; slot?: { n: number } }>({ list: [{ n: 1 }] });

		applyOperations(replica, projectTransport(delivered), "do");

		expect(replica.slot).toBe(replica.list[0]);
	});

	it("re-mints every key of a decomposed replace, including keys the old value shared", () => {
		const state = createMutableState<{ hub: { n: number }; box: Record<string, unknown> }>({
			hub: { n: 1 },
			box: { keep: "KEEP", other: 2 },
		});
		const heard = record(state);

		transact(state, () => {
			state.box = { keep: "KEEP", inner: { alias: state.hub } };
		});

		const delivered = heard[0] ?? [];
		const replica = createMutableState<{ hub: { n: number }; box: Record<string, unknown> }>({
			hub: { n: 1 },
			box: { keep: "KEEP", other: 2 },
		});

		applyOperations(replica, projectTransport(delivered), "do");

		expect(replica.box.keep).toBe("KEEP");
		expect(replica.box).not.toHaveProperty("other");
		expect((replica.box.inner as { alias: unknown }).alias).toBe(replica.hub);
	});

	it("declines collapse when a collapsing container loses one route to a surviving node", () => {
		const start = (): { keep: { n: number }; bag: Record<string, unknown> } => ({
			keep: { n: 1 },
			bag: { x: 1, y: 2 },
		});

		const state = createMutableState(start());

		state.bag.slot = state.keep;

		const heard = record(state);

		transact(state, () => {
			delete state.bag.slot;
			delete state.bag.x;
			delete state.bag.y;
		});

		const delivered = heard[0] ?? [];

		expect(shapeOps(delivered).some((pair) => pair.undo.verb === "link")).toBe(true);

		const replica = createMutableState(start());

		replica.bag.slot = replica.keep;

		const projected = projectTransport(delivered);

		applyOperations(replica, projected, "do");
		applyOperations(replica, projected, "undo");

		expect(replica.bag.slot).toBe(replica.keep);
	});

	it("declines collapse when an overwritten key's node survives externally", () => {
		const start = (): { keep: { n: number }; bag: Record<string, unknown> } => ({
			keep: { n: 1 },
			bag: { x: 1, y: 2 },
		});

		const state = createMutableState(start());

		state.bag.slot = state.keep;

		const heard = record(state);

		transact(state, () => {
			state.bag.slot = { n: 99 };
			delete state.bag.x;
			delete state.bag.y;
		});

		const delivered = heard[0] ?? [];

		expect(shapeOps(delivered).some((pair) => pair.undo.verb === "link")).toBe(true);

		const replica = createMutableState(start());

		replica.bag.slot = replica.keep;

		const projected = projectTransport(delivered);

		applyOperations(replica, projected, "do");
		expect(replica.bag.slot).toEqual({ n: 99 });
		expect(replica.bag.slot).not.toBe(replica.keep);

		applyOperations(replica, projected, "undo");
		expect(replica.bag.slot).toBe(replica.keep);
	});

	it("carries by value a node reachable only through an ignore()d container", () => {
		const state = createMutableState<{
			hold?: { n: number };
			wrapped: { held: { n: number } };
			slot?: { n: number };
		}>({
			hold: { n: 1 },
			wrapped: ignore({ held: { n: 0 } }),
		});

		const node = state.hold!;

		state.wrapped = ignore({ held: node });
		delete state.hold;

		const heard = record(state);

		transact(state, () => {
			state.slot = node;
		});

		const delivered = heard[0] ?? [];

		expect(delivered).toHaveLength(1);
		expect(delivered[0]?.do.verb).toBe("assign");
		expect(delivered[0]?.do).not.toMatchObject({ verb: "link" });

		const replica = createMutableState<{
			hold?: { n: number };
			wrapped: { held: { n: number } };
			slot?: { n: number };
		}>({
			hold: { n: 1 },
			wrapped: ignore({ held: { n: 0 } }),
		});

		const replicaNode = replica.hold!;

		replica.wrapped = ignore({ held: replicaNode });
		delete replica.hold;

		applyOperations(replica, projectTransport(delivered), "do");
		expect(replica.slot).toEqual({ n: 1 });
		expect(replica.slot).not.toBe(replicaNode);
	});

	it("mints a link for a fresh subtree embedding a tracked node in loose mode", () => {
		const state = createMutableState<{ held: { n: number }; wrap?: { inner: { n: number } } }>(
			{ held: { n: 1 } },
			{ strict: false },
		);
		const heard = record(state);

		transact(state, () => {
			state.wrap = { inner: state.held };
		});

		const delivered = heard[0] ?? [];

		expect(shapeOps(delivered).some((pair) => pair.do.verb === "link")).toBe(true);

		const replica = createMutableState<{ held: { n: number }; wrap?: { inner: { n: number } } }>(
			{ held: { n: 1 } },
			{ strict: false },
		);

		applyOperations(replica, projectTransport(delivered), "do");
		expect(replica.wrap?.inner).toBe(replica.held);
	});

	it("mints no links from the public plain-object surface", () => {
		const shared = { n: 1 };
		const cyclic: Record<string, unknown> = { x: 1 };

		cyclic.self = cyclic;

		const removal = diffObjects({ a: shared, b: shared }, { b: shared });
		const cycle = diffObjects({ x: 1 }, cyclic);

		for (const pair of [...removal, ...cycle]) {
			expect(pair.do.verb).not.toBe("link");
			expect(pair.undo.verb).not.toBe("link");
		}
	});
});
