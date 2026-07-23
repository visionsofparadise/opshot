import { createState, type State } from "../createState";
import { identify, isSameIdentity } from "../identity";
import { applyOps } from "../ops/applyOps";
import type { Op, Operation } from "../ops/operation";
import { addressOf } from "./address";
import { TrackedDate } from "./trackedDate";
import { TrackedMap } from "./trackedMap";

const record = <T extends object>(state: State<T>): Array<Array<Op>> => {
	const heard = new Array<Array<Op>>();

	state.op.subscribe((_snapshot, ops) => heard.push(ops));

	return heard;
};

const doPaths = (ops: Array<Op> | undefined): Array<Operation["path"]> => (ops ?? []).map((pair) => pair.do.path);

describe("TrackedMap", () => {
	it("implements the Map surface with ordered insertion and overwrite semantics", () => {
		const map = new TrackedMap<string, number>([
			["a", 1],
			["b", 2],
		]);

		expect(map.size).toBe(2);
		expect(map.has("a")).toBe(true);
		expect(map.get("b")).toBe(2);
		expect(map.set("a", 10)).toBe(map);
		map.set("c", 3);
		expect([...map]).toEqual([
			["a", 10],
			["b", 2],
			["c", 3],
		]);
		expect(map.delete("b")).toBe(true);
		expect(map.delete("missing")).toBe(false);
		expect([...map.keys()]).toEqual(["a", "c"]);
		expect([...map.values()]).toEqual([10, 3]);
		map.clear();
		expect(map.size).toBe(0);
	});

	it("keeps tombstones so re-adds append and iteration skips deleted slots", () => {
		const map = new TrackedMap<string, number>([
			["a", 1],
			["b", 2],
		]);

		map.delete("a");
		map.set("c", 3);

		expect([...map]).toEqual([
			["b", 2],
			["c", 3],
		]);
		expect(map.size).toBe(2);
	});

	it("iterates live like a native Map: sees adds, skips mid-iteration deletes, ends on clear", () => {
		const map = new TrackedMap<string, number>([
			["a", 1],
			["b", 2],
		]);
		const seenAdd = new Array<string>();

		for (const [key] of map) {
			seenAdd.push(key);
			if (key === "a") map.set("c", 3);
		}

		expect(seenAdd).toEqual(["a", "b", "c"]);

		const control = new Map<string, number>([
			["a", 1],
			["b", 2],
			["c", 3],
		]);
		const seenDelete = new Array<string>();
		const seenDeleteControl = new Array<string>();

		for (const [key] of map) {
			seenDelete.push(key);
			if (key === "a") map.delete("c");
		}
		for (const [key] of control) {
			seenDeleteControl.push(key);
			if (key === "a") control.delete("c");
		}

		expect(seenDelete).toEqual(seenDeleteControl);

		const cleared = new Array<string>();

		for (const [key] of map) {
			cleared.push(key);
			if (key === "a") map.clear();
		}

		expect(cleared).toEqual(["a"]);
	});

	it("normalizes raw, proxy, and snapshot key handles by storage identity", () => {
		const key = { id: 1 };
		const state = createState({ map: new TrackedMap([[key, "selected"]]) });
		const snapshotKey = [...state.map.keys()][0];

		if (!snapshotKey) throw new Error("missing snapshot key");

		state.mutate((mutable) => {
			const proxyKey = [...mutable.map.keys()][0];

			if (!proxyKey) throw new Error("missing proxy key");
			expect(mutable.map.get(key)).toBe("selected");
			expect(mutable.map.get(snapshotKey)).toBe("selected");
			expect(mutable.map.get(proxyKey)).toBe("selected");
			mutable.map.set(snapshotKey, "updated");
		});

		expect(state.op.unwrap().map.size).toBe(1);
		expect(state.op.unwrap().map.get(key)).toBe("updated");
	});

	it("emits plain-data membership, replacement, and removal ops", () => {
		const pad = "x".repeat(5_000);
		const map = new TrackedMap<string, string>();

		for (let index = 0; index < 20; index++) map.set(`pad${index}`, pad);

		const state = createState({ map });
		const heard = record(state);
		const addr = addressOf("a");

		state.mutate((mutable) => mutable.map.set("a", "1"));
		state.mutate((mutable) => mutable.map.set("a", "2"));
		state.mutate((mutable) => mutable.map.delete("a"));

		expect(doPaths(heard[0])).toEqual(
			expect.arrayContaining([
				["map", "index", addr],
				["map", "slots", 20],
				["map", "count"],
			]),
		);
		expect(heard[0]?.find((pair) => pair.do.path[1] === "index")?.do).toMatchObject({ op: "add", path: ["map", "index", addr], value: 20 });
		expect(heard[0]?.find((pair) => pair.do.path[1] === "slots" && pair.do.path[2] === 20)?.do.op).toBe("add");
		expect(heard[0]?.find((pair) => pair.do.path[1] === "count")?.do).toMatchObject({ op: "replace", path: ["map", "count"] });

		expect(doPaths(heard[1])).toEqual([["map", "slots", 20]]);
		expect(heard[1]?.[0]?.do.op).toBe("replace");

		expect(doPaths(heard[2])).toEqual(
			expect.arrayContaining([
				["map", "index", addr],
				["map", "slots", 20],
				["map", "count"],
			]),
		);
		expect(heard[2]?.find((pair) => pair.do.path[1] === "index")?.do.op).toBe("remove");
		expect(heard[2]?.find((pair) => pair.do.path[1] === "slots")?.do).toMatchObject({ op: "replace", path: ["map", "slots", 20], value: null });
	});

	it("emits key and value interiors through slots", () => {
		const key = { profile: { id: 1 } };
		const value = { count: 1 };
		// Heavy unchanged padding keeps interiors atomic so the path shape stays observable.
		const pad = "x".repeat(5_000);
		const state = createState({
			map: new TrackedMap<object | string, object | string>([
				[key, value],
				["pad0", pad],
				["pad1", pad],
			]),
		});
		const heard = record(state);

		state.mutate((mutable) => {
			const mutableValue = mutable.map.get(key) as typeof value | undefined;

			if (!mutableValue) throw new Error("missing entry");
			mutableValue.count = 2;
		});
		state.mutate((mutable) => {
			const mutableKey = [...mutable.map.keys()][0] as typeof key;

			if (!mutableKey) throw new Error("missing key");
			mutableKey.profile.id = 2;
		});

		expect(heard[0]?.[0]?.do.path).toEqual(["map", "slots", 0, 1, "count"]);
		expect(heard[1]?.[0]?.do.path).toEqual(["map", "slots", 0, 0, "profile", "id"]);
	});

	it("round-trips clear and delete-readd through one collapsed container replace", () => {
		const state = createState({
			map: new TrackedMap([
				["a", 1],
				["b", 2],
			]),
		});
		const heard = record(state);

		state.mutate((mutable) => {
			mutable.map.clear();
			mutable.map.set("b", 20);
			mutable.map.set("a", 10);
		});

		const ops = heard[0] ?? [];

		expect(ops).toHaveLength(1);
		expect(ops[0]?.do).toMatchObject({ op: "replace", path: ["map"] });
		applyOps(
			state,
			[...ops].reverse().map((pair) => pair.undo),
		);
		expect([...state.op.unwrap().map]).toEqual([
			["a", 1],
			["b", 2],
		]);
		applyOps(
			state,
			ops.map((pair) => pair.do),
		);
		expect([...state.op.unwrap().map]).toEqual([
			["b", 20],
			["a", 10],
		]);
	});

	it("preserves object-key identity and aliased values through replay", () => {
		const key = { id: 1 };
		const shared = { count: 1 };
		const state = createState({
			map: new TrackedMap([
				[key, shared],
				[{ id: 2 }, shared],
			]),
		});
		const selection = new Map([[identify(key), "selected"]]);
		const heard = record(state);

		state.mutate((mutable) => mutable.map.clear());
		const ops = heard[0] ?? [];
		applyOps(
			state,
			[...ops].reverse().map((pair) => pair.undo),
		);

		const entries = [...state.op.unwrap().map];

		expect(entries[0]?.[0] && selection.get(identify(entries[0][0]))).toBe("selected");
		expect(entries[0]?.[1]).toBe(entries[1]?.[1]);
		expect(entries[0]?.[1] && isSameIdentity(entries[0][1], shared)).toBe(true);
	});

	it("recurses through nested arrays and facades on stable map values", () => {
		const state = createState({ map: new TrackedMap([["a", { items: ["x"], when: new TrackedDate(0) }]]) });
		const heard = record(state);

		state.mutate((mutable) => {
			const value = mutable.map.get("a");

			if (!value) throw new Error("missing value");
			value.items.push("y");
			value.when.setTime(1);
		});

		const ops = heard[0] ?? [];
		applyOps(
			state,
			[...ops].reverse().map((pair) => pair.undo),
		);
		expect(state.op.unwrap().map.get("a")?.items).toEqual(["x"]);
		expect(state.op.unwrap().map.get("a")?.when.getTime()).toBe(0);
		applyOps(
			state,
			ops.map((pair) => pair.do),
		);
		expect(state.op.unwrap().map.get("a")?.items).toEqual(["x", "y"]);
		expect(state.op.unwrap().map.get("a")?.when.getTime()).toBe(1);
	});

	it("retains full function after a minimal clean-class clone", () => {
		const map = new TrackedMap<string, number>([
			["a", 1],
			["b", 2],
		]);
		const clone = Object.create(Object.getPrototypeOf(map)) as TrackedMap<string, number>;

		for (const key of Object.keys(map as object)) {
			Reflect.set(clone, key, Reflect.get(map as object, key));
		}

		expect(clone.size).toBe(2);
		expect(clone.get("a")).toBe(1);
		expect(clone.has("b")).toBe(true);
		clone.set("c", 3);
		expect(clone.get("c")).toBe(3);
		expect(clone.size).toBe(3);
		expect(clone.delete("a")).toBe(true);
		expect([...clone]).toEqual([
			["b", 2],
			["c", 3],
		]);
		expect(typeof clone.set).toBe("function");
		expect(Object.prototype.toString.call(clone)).toBe("[object TrackedMap]");
	});

	it("throws when mutating a snapshot copy", () => {
		const state = createState({
			map: new TrackedMap([
				["a", 1],
			]),
		});
		const snapshot = state.op.unwrap();

		expect(() => snapshot.map.set("b", 2)).toThrow("opshot: cannot mutate a tracked collection snapshot");
		expect(snapshot.map.size).toBe(1);
	});
});
