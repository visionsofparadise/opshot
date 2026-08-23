import { subscribe } from "../subscribe";
import { transact } from "../transact/transact";
import { createMutableState } from "../createMutableState";
import { identify, isSameIdentity } from "../identity";
import { applyOperations } from "../ops/applyOperations";
import { type Operation } from "../ops/operation";
import { shapeOps } from "../ops/operationShape";
import { addressOf } from "./address";
import { TrackedDate } from "./trackedDate";
import { TrackedMap } from "./trackedMap";

type MapStore<K, V> = {
	slots: Array<readonly [K, V] | null>;
	index: Record<string, number>;
	count: number;
};

type MapLike<K, V> = {
	set: (key: K, value: V) => unknown;
	delete: (key: K) => boolean;
	clear: () => void;
	[Symbol.iterator]: () => IterableIterator<[K, V]>;
};

const record = <T extends object>(state: T): Array<Array<Operation>> => {
	const heard = new Array<Array<Operation>>();

	subscribe(state, (ops) => heard.push([...ops]));

	return heard;
};

const storeOf = (map: object): MapStore<string, number> => map as unknown as MapStore<string, number>;

const layoutOf = (map: object): { slots: unknown; index: unknown; count: number } => {
	const store = storeOf(map);

	return {
		slots: JSON.parse(JSON.stringify(store.slots)),
		index: JSON.parse(JSON.stringify(store.index)),
		count: store.count,
	};
};

const keysSeenDuring = <K, V>(
	collection: MapLike<K, V>,
	mutate: (collection: MapLike<K, V>, key: K) => void,
): Array<K> => {
	const seen = new Array<K>();

	for (const [key] of collection) {
		seen.push(key);
		mutate(collection, key);
	}

	return seen;
};

const asPlainData = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

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

	it("undo across a compaction restores the pre-compaction slot layout including tombstones", () => {
		const state = createMutableState({
			map: new TrackedMap([
				["a", 1],
				["b", 2],
				["c", 3],
				["d", 4],
			]),
		});
		const heard = record(state);

		transact(state, () => {
			state.map.delete("b");
		});

		const preCompaction = layoutOf(state.map);

		expect(preCompaction).toEqual({
			slots: [["a", 1], null, ["c", 3], ["d", 4]],
			index: { sa: 0, sc: 2, sd: 3 },
			count: 3,
		});

		transact(state, () => {
			state.map.delete("d");
		});

		expect(layoutOf(state.map)).toEqual({
			slots: [
				["a", 1],
				["c", 3],
			],
			index: { sa: 0, sc: 1 },
			count: 2,
		});

		const compactionOps = heard[1] ?? [];

		applyOperations(state, compactionOps, "undo");
		expect(layoutOf(state.map)).toEqual(preCompaction);
		expect([...state.map]).toEqual([
			["a", 1],
			["c", 3],
			["d", 4],
		]);
	});

	it("mutation during iteration matches a native Map, and two iterators keep positions across a rebuild", () => {
		const seed: Array<[string, number]> = [
			["a", 1],
			["b", 2],
		];
		const tracked = new TrackedMap(seed);
		const native = new Map(seed);

		expect(
			keysSeenDuring(tracked, (collection, key) => {
				if (key === "a") collection.set("c", 3);
			}),
		).toEqual(
			keysSeenDuring(native, (collection, key) => {
				if (key === "a") collection.set("c", 3);
			}),
		);

		expect(
			keysSeenDuring(tracked, (collection, key) => {
				if (key === "a") collection.delete("c");
			}),
		).toEqual(
			keysSeenDuring(native, (collection, key) => {
				if (key === "a") collection.delete("c");
			}),
		);

		expect(
			keysSeenDuring(tracked, (collection, key) => {
				if (key === "a") collection.clear();
			}),
		).toEqual(
			keysSeenDuring(native, (collection, key) => {
				if (key === "a") collection.clear();
			}),
		);

		const rebuilding = new TrackedMap([
			["a", 1],
			["b", 2],
			["c", 3],
			["d", 4],
		]);
		const first = rebuilding.entries();
		const second = rebuilding.entries();

		expect(first.next().value).toEqual(["a", 1]);
		expect(second.next().value).toEqual(["a", 1]);
		expect(second.next().value).toEqual(["b", 2]);

		expect(rebuilding.delete("b")).toBe(true);
		expect(rebuilding.delete("d")).toBe(true);
		expect([...rebuilding]).toEqual([
			["a", 1],
			["c", 3],
		]);
		expect([...first]).toEqual([["c", 3]]);
		expect([...second]).toEqual([["c", 3]]);
	});

	it("clear-then-re-add within one window emits net fine-grained ops over slots, index, and count", () => {
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
			state.map.set("c", 30);
		});

		const ops = heard[0] ?? [];
		const shaped = shapeOps(ops);
		const fields = shaped.map((pair) => pair.do.path[1]);

		expect(fields).toEqual(expect.arrayContaining(["slots", "index", "count"]));
		expect(asPlainData(shaped)).toEqual(shaped);

		applyOperations(state, ops, "undo");
		expect([...state.map]).toEqual([
			["a", 1],
			["b", 2],
		]);

		applyOperations(state, ops, "do");
		expect([...state.map]).toEqual([
			["b", 20],
			["a", 10],
			["c", 30],
		]);
	});

	it("set, overwrite, and delete emit plain-data assign and delete pairs", () => {
		const state = createMutableState({
			map: new TrackedMap([
				["a", 1],
				["b", 2],
				["c", 3],
			]),
		});
		const heard = record(state);

		transact(state, () => {
			state.map.set("d", 4);
		});
		transact(state, () => {
			state.map.set("a", 10);
		});
		transact(state, () => {
			expect(state.map.delete("b")).toBe(true);
			expect(state.map.delete("b")).toBe(false);
		});

		const shaped = heard.map((ops) => shapeOps(ops));

		expect(asPlainData(shaped)).toEqual(shaped);
		expect(shaped[0]).toEqual([
			{
				do: { verb: "assign", path: ["map", "slots", "length"], value: 4 },
				undo: { verb: "assign", path: ["map", "slots", "length"], value: 3 },
			},
			{
				do: { verb: "assign", path: ["map", "slots", 3], value: ["d", 4], ids: [7] },
				undo: { verb: "delete", path: ["map", "slots", 3] },
			},
			{
				do: { verb: "assign", path: ["map", "index", addressOf("d")], value: 3 },
				undo: { verb: "delete", path: ["map", "index", addressOf("d")] },
			},
			{
				do: { verb: "assign", path: ["map", "count"], value: 4 },
				undo: { verb: "assign", path: ["map", "count"], value: 3 },
			},
		]);
		expect(shaped[1]).toEqual([
			{
				do: { verb: "assign", path: ["map", "slots", 0], value: ["a", 10], ids: [8] },
				undo: { verb: "assign", path: ["map", "slots", 0], value: ["a", 1], ids: [3] },
			},
		]);
		expect(shaped[2]).toEqual([
			{
				do: { verb: "assign", path: ["map", "slots", 1], value: null },
				undo: { verb: "assign", path: ["map", "slots", 1], value: ["b", 2], ids: [4] },
			},
			{
				do: { verb: "delete", path: ["map", "index", addressOf("b")] },
				undo: { verb: "assign", path: ["map", "index", addressOf("b")], value: 1 },
			},
			{
				do: { verb: "assign", path: ["map", "count"], value: 3 },
				undo: { verb: "assign", path: ["map", "count"], value: 4 },
			},
		]);
		expect([...state.map]).toEqual([
			["a", 10],
			["c", 3],
			["d", 4],
		]);
	});

	it("keys, values, and forEach project stored pairs with native argument order", () => {
		const map = new TrackedMap([
			["a", 1],
			["b", 2],
		]);
		const calls = new Array<[number, string, boolean]>();

		map.forEach((value, key, received) => {
			calls.push([value, key, received === map]);
		});

		expect([...map.keys()]).toEqual(["a", "b"]);
		expect([...map.values()]).toEqual([1, 2]);
		expect(calls).toEqual([
			[1, "a", true],
			[2, "b", true],
		]);
	});
});
