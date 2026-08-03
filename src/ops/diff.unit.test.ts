import { snapshot } from "valtio/vanilla";

import { createMutableState, type MutableStateOptions } from "../createMutableState";
import { isSameIdentity } from "../identity";
import { subscribe } from "../subscribe";
import { addressOf } from "../tracked/address";
import { TrackedDate } from "../tracked/trackedDate";
import { TrackedMap } from "../tracked/trackedMap";
import { TrackedSet } from "../tracked/trackedSet";
import { transact } from "../transact";
import { applyOps } from "./applyOps";
import { getCyclicPath } from "./cloneValue";
import { diffSnapshots } from "./diff";
import { type Op, type Operation } from "./operation";

const readValue = (operation: Operation): unknown => ("value" in operation ? operation.value : undefined);

const record = <T extends object>(state: T): Array<Array<Op>> => {
	const heard = new Array<Array<Op>>();

	subscribe(state, (ops) => heard.push([...ops]));

	return heard;
};

const replayUndo = <T extends object>(state: T, ops: Array<Op>): void =>
	applyOps(
		state,
		[...ops].reverse().map((pair) => pair.undo),
	);
const replayDo = <T extends object>(state: T, ops: Array<Op>): void =>
	applyOps(
		state,
		ops.map((pair) => pair.do),
	);

describe("diffSnapshots: atomic flat paths", () => {
	it("emits addition, change, and removal pairs at frozen array paths", () => {
		const ops = diffSnapshots({ kept: 1, changed: 2, removed: 3 }, { kept: 1, changed: 4, added: 5 });

		expect(ops).toEqual([
			{ do: { op: "assign", path: ["changed"], value: 4 }, undo: { op: "assign", path: ["changed"], value: 2 } },
			{ do: { op: "delete", path: ["removed"] }, undo: { op: "assign", path: ["removed"], value: 3 } },
			{ do: { op: "assign", path: ["added"], value: 5 }, undo: { op: "delete", path: ["added"] } },
		]);
		for (const pair of ops) expect(Object.isFrozen(pair.do.path)).toBe(true);
	});

	it("carries added-versus-changed on the undo half, both halves assigning", () => {
		const ops = diffSnapshots({ changed: 1 }, { changed: 2, added: 3 });
		const change = ops.find((pair) => pair.do.path[0] === "changed");
		const addition = ops.find((pair) => pair.do.path[0] === "added");

		expect(change?.do.op).toBe("assign");
		expect(addition?.do.op).toBe("assign");

		expect(change?.undo.op).toBe("assign");
		expect(readValue(change?.undo ?? { op: "delete", path: [] })).toBe(1);
		expect(addition?.undo.op).toBe("delete");
	});

	it("undoes an assignment of undefined onto an absent key with a delete, not a stored undefined", () => {
		const ops = diffSnapshots({}, { value: undefined } as { value?: number });

		expect(ops).toHaveLength(1);
		expect(ops[0]?.do.op).toBe("assign");
		expect(readValue(ops[0]?.do ?? { op: "delete", path: [] })).toBeUndefined();
		expect(ops[0]?.undo.op).toBe("delete");
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
		expect(readValue(ops[1]?.do ?? { op: "delete", path: [] })).toEqual({ count: 2 });
	});

	it("compares leaves with Object.is so NaN equals NaN and 0 differs from -0", () => {
		expect(diffSnapshots({ n: Number.NaN }, { n: Number.NaN })).toEqual([]);
		expect(diffSnapshots({ z: 0 }, { z: -0 }).map((pair) => pair.do)).toEqual([
			{ op: "assign", path: ["z"], value: -0 },
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
		expect(heard[0]?.[0]?.do).toMatchObject({ op: "assign", path: ["value"] });
		expect(isSameIdentity(before, state.value)).toBe(false);
	});

	it("rejects primitive, unsupported, and incompatible roots", () => {
		expect(() => diffSnapshots(1 as unknown as object, 2 as unknown as object)).toThrow(
			"compatible supported object roots",
		);
		expect(() => diffSnapshots({}, [])).toThrow("compatible supported object roots");
		expect(() => diffSnapshots(new Map(), new Map())).toThrow("compatible supported object roots");
	});

	it("accepts plain-data facades as object-container roots", () => {
		const before = new TrackedMap([["a", 1]]);
		const after = new TrackedMap([["a", 2]]);

		expect(() => diffSnapshots(before, after)).not.toThrow();
	});

	it("emits constructor and prototype as ordinary data rather than rejecting them", () => {
		const before = { h: { constructor: { note: 1 } } };
		const after = { h: { constructor: { note: 1, prototype: { x: 1 } } } };
		const ops = diffSnapshots(before, after);

		expect(ops.map((op) => op.do.path)).toEqual([["h"]]);

		const [first] = ops;

		if (first === undefined) throw new Error("expected one op");

		const carried = (first.do as { value: { constructor: { prototype: { x: number } } } }).value;

		expect(carried.constructor.prototype.x).toBe(1);
		expect(Object.prototype).not.toHaveProperty("x");

		const hostile = JSON.parse('{"__proto__": {"polluted": true}}') as object;

		expect(diffSnapshots({}, hostile).map((op) => op.do.path)).toEqual([["__proto__"]]);
		expect(Object.prototype).not.toHaveProperty("polluted");

		const nestedHostile = JSON.parse('{"__proto__": {"polluted": true}, "keep": 2}') as object;

		expect(Object.getOwnPropertyNames(nestedHostile)).toEqual(["__proto__", "keep"]);

		const [sanitized] = diffSnapshots({}, { a: nestedHostile });

		if (sanitized === undefined) throw new Error("expected one op");

		expect(Object.getOwnPropertyNames((sanitized.do as { value: object }).value)).toEqual(["keep"]);
	});

	it("orders sparse growth length before tail additions and preserves holes", () => {
		const before = [1];
		const after = new Array<unknown>(1);

		after[0] = 1;

		after.length = 4;
		after[3] = undefined;

		const ops = diffSnapshots(before, after);

		expect(ops.map((pair) => pair.do)).toEqual([
			{ op: "assign", path: ["length"], value: 4 },
			{ op: "assign", path: [3], value: undefined },
		]);
		expect(ops.map((pair) => pair.undo)).toEqual([
			{ op: "assign", path: ["length"], value: 1 },
			{ op: "delete", path: [3] },
		]);
	});

	it("orders truncated removals before shrink and reverse undo expands first", () => {
		const before = [1, 2, 3];
		const after = [1];
		const ops = diffSnapshots(before, after);

		expect(ops.map((pair) => pair.do)).toEqual([
			{ op: "delete", path: [1] },
			{ op: "delete", path: [2] },
			{ op: "assign", path: ["length"], value: 1 },
		]);
		expect([...ops].reverse().map((pair) => pair.undo)).toEqual([
			{ op: "assign", path: ["length"], value: 3 },
			{ op: "assign", path: [2], value: 3 },
			{ op: "assign", path: [1], value: 2 },
		]);
	});

	it("distinguishes holes from stored undefined in overlap", () => {
		const hole = new Array<unknown>(1);
		const stored = [undefined];

		expect(diffSnapshots(hole, stored)[0]?.do).toEqual({ op: "assign", path: [0], value: undefined });
		expect(diffSnapshots(stored, hole)[0]?.do).toEqual({ op: "delete", path: [0] });
	});

	it("emits enumerable array non-index string properties as ordinary paths", () => {
		const before = [1];
		const after = [1];

		Object.defineProperty(before, "label", { value: "a", enumerable: true });
		Object.defineProperty(after, "label", { value: "b", enumerable: true });

		expect(diffSnapshots(before, after)[0]?.do).toEqual({ op: "assign", path: ["label"], value: "b" });
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
		expect(ops[0]?.do).toMatchObject({ op: "assign", path: ["map"] });
		expect([...(readValue(ops[0]?.do ?? { op: "delete", path: [] }) as TrackedMap<string, number>)]).toEqual([
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
		expect(ops[0]?.do).toMatchObject({ op: "assign", path: ["set"] });
		expect([...(readValue(ops[0]?.do ?? { op: "delete", path: [] }) as TrackedSet<number>)]).toEqual([2, 3]);
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

describe("diffSnapshots: container collapse", () => {
	it("mass shrink emits one assign at the array path and round-trips", () => {
		const state = createMutableState({ list: Array.from({ length: 2000 }, (_, index) => index) });
		const heard = record(state);

		transact(state, () => {
			state.list.length = 10;
		});

		const after = state;
		const ops = heard[0] ?? [];

		expect(ops).toHaveLength(1);
		expect(ops[0]?.do).toMatchObject({ op: "assign", path: ["list"] });
		expect(readValue(ops[0]?.do ?? { op: "delete", path: [] })).toEqual(
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
		expect(ops.map((pair) => pair.do)).toEqual(
			edited.map((index) => ({ op: "assign", path: ["tree", index, "n"], value: index + 1 })),
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
			ops.every((pair) => pair.do.op === "assign" && pair.do.path[0] === "bag" && pair.do.path.length === 2),
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
		expect(ops[0]?.do).toMatchObject({ op: "assign", path: ["outer"] });
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
		expect(ops[0]?.do).toMatchObject({ op: "assign", path: ["map"] });
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
		expect(ops.every((pair) => pair.do.op === "assign" && pair.do.path.length === 1)).toBe(true);
	});

	it("watchdog mass edit reaches the stream as one side-effect container assign", async () => {
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
		expect(heard[0]?.ops[0]?.do).toMatchObject({ op: "assign", path: ["list"] });
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
		expect(ops[0]?.do).toMatchObject({ op: "assign", path: ["list"] });
		expect(readValue(ops[0]?.do ?? { op: "delete", path: [] })).toEqual([1, 20, 30]);

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

interface Formation {
	readonly name: string;
	readonly path: ReadonlyArray<string>;
	readonly start: () => { readonly state: object; readonly form: () => void };
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

describe("diffSnapshots: cyclic values", () => {
	const formations: ReadonlyArray<Formation> = [
		{
			name: "a child self-cycle",
			path: ["box", "self"],
			start: () => {
				const state = createMutableState<{ box: { n: number; self?: object } }>({ box: { n: 1 } });

				return {
					state,
					form: () => {
						state.box.self = state.box;
					},
				};
			},
		},
		{
			name: "a root self-cycle",
			path: ["self"],
			start: () => {
				const state = createMutableState<{ n: number; self?: object }>({ n: 1 });

				return {
					state,
					form: () => {
						state.self = state;
					},
				};
			},
		},
		{
			name: "a back-link to the root",
			path: ["child", "back"],
			start: () => {
				const state = createMutableState<{ child: { n: number; back?: object } }>({ child: { n: 1 } });

				return {
					state,
					form: () => {
						state.child.back = state;
					},
				};
			},
		},
		{
			name: "a wholesale cyclic object",
			path: ["node"],
			start: () => {
				const state = createMutableState<{ n: number; node?: object }>({ n: 1 });

				return {
					state,
					form: () => {
						const node: { m: number; self?: object } = { m: 1 };

						node.self = node;
						state.node = node;
					},
				};
			},
		},
		{
			name: "a two-node cycle",
			path: ["a", "peer"],
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
				};
			},
		},
	];

	it.each(formations.map((formation) => [formation.name, formation] as const))(
		"throws at the transact forming %s, naming the path and delivering no op",
		(_name, formation) => {
			const { state, form } = formation.start();
			const heard = record(state);
			let caught: unknown;

			try {
				transact(state, form);
			} catch (error) {
				caught = error;
			}

			expect(getCyclicPath(caught)).toEqual(formation.path);
			expect(heard).toHaveLength(0);
		},
	);

	it("routes a bare forming write to the flush with the transact message and delivers no op", async () => {
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

		expect(thrown).toHaveLength(1);
		expect(thrown[0]).toBeInstanceOf(Error);
		expect((thrown[0] as Error).message).toMatch(/bare write created a cyclic value at \/box\/self/);
		expect((thrown[0] as Error).message).toMatch(/Use transact for catchable cycle errors/);
		expect(heard).toHaveLength(0);
	});

	it("throws at a collapse carrying a cycle formed while nothing was subscribed", () => {
		interface Holder {
			readonly holder: {
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
		let caught: unknown;

		try {
			transact(state, () => {
				state.holder.a = 10;
				state.holder.b = 20;
				state.holder.c = 30;
				state.holder.d = 40;
				state.holder.e = 50;
			});
		} catch (error) {
			caught = error;
		}

		expect(getCyclicPath(caught)).toEqual(["holder"]);
		expect(heard).toHaveLength(0);
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

	it("delivers a removal for the documented repair breaking the cycle by reference", () => {
		const { state, repair } = startRepair();
		const heard = record(state);

		transact(state, repair);

		expect(heard).toHaveLength(1);
		expect(heard[0]).toHaveLength(1);
		expect(heard[0]?.[0]?.do).toMatchObject({ op: "delete", path: ["box", "self"] });
		expect(state.box.self).toBeUndefined();
	});

	it("delivers the same repair on the bare lane, raising nothing at the flush", async () => {
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
		expect(heard[0]?.[0]?.do).toMatchObject({ op: "delete", path: ["box", "self"] });
	});

	it("carries an undo on the repair that throws when its value is read and when it is applied", () => {
		const { state, repair } = startRepair();
		const heard = record(state);

		transact(state, repair);

		const delivered = heard[0] ?? [];
		const undo = delivered[0]?.undo;

		expect(undo?.op).toBe("assign");
		expect(() => readValue(undo ?? { op: "delete", path: [] })).toThrow(/cyclic value at \/box\/self/);

		const before = heard.length;

		expect(() => {
			replayUndo(state, delivered);
		}).toThrow(/cyclic value at \/box\/self/);

		expect(state.box.self).toBe(state.box);
		expect(heard).toHaveLength(before);
	});

	it.each(rideAlongBackEdges)(
		"refuses %s, which the clone carries and the enumerable walk misses",
		(_name, create) => {
			const state = createMutableState<{ n: number; node?: object }>({ n: 1 });
			const heard = record(state);
			let caught: unknown;

			try {
				transact(state, () => {
					state.node = create();
				});
			} catch (error) {
				caught = error;
			}

			expect(getCyclicPath(caught)).toEqual(["node"]);
			expect(heard).toHaveLength(0);
		},
	);

	it("diffs a deeply aliased diamond, walking each shared subgraph once", () => {
		const state = createMutableState<{ n: number; diamond?: object }>({ n: 1 });
		const heard = record(state);

		transact(state, () => {
			state.diamond = buildAliasedDiamond(64);
		});

		expect(heard[0]).toHaveLength(1);
		expect(heard[0]?.[0]?.do).toMatchObject({ op: "assign", path: ["diamond"] });
	});
});
