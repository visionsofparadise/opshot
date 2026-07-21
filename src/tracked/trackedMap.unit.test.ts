import { createState, type State } from "../createState";
import { identify, isSameIdentity } from "../identity";
import { applyOps } from "../ops/applyOps";
import type { Op } from "../ops/operation";
import { getPathSelector } from "../ops/path";
import { TrackedDate } from "./trackedDate";
import { TrackedMap } from "./trackedMap";

const record = <T extends object>(state: State<T>): Array<Array<Op>> => {
	const heard = new Array<Array<Op>>();

	state.op.subscribe((_snapshot, ops) => heard.push(ops));

	return heard;
};

describe("TrackedMap", () => {
	it("implements the Map surface with ordered insertion and overwrite semantics", () => {
		const map = new TrackedMap<string, number>([["a", 1], ["b", 2]]);

		expect(map.size).toBe(2);
		expect(map.has("a")).toBe(true);
		expect(map.get("b")).toBe(2);
		expect(map.set("a", 10)).toBe(map);
		map.set("c", 3);
		expect([...map]).toEqual([["a", 10], ["b", 2], ["c", 3]]);
		expect(map.delete("b")).toBe(true);
		expect(map.delete("missing")).toBe(false);
		expect([...map.keys()]).toEqual(["a", "c"]);
		expect([...map.values()]).toEqual([10, 3]);
		map.clear();
		expect(map.size).toBe(0);
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

	it("emits atomic insertion, replacement, and removal paths", () => {
		const key = { id: 1 };
		const state = createState({ map: new TrackedMap<typeof key, number>() });
		const heard = record(state);

		state.mutate((mutable) => mutable.map.set(key, 1));
		state.mutate((mutable) => mutable.map.set(key, 2));
		state.mutate((mutable) => mutable.map.delete(key));

		const insertion = heard[0]?.[0];
		const replacement = heard[1]?.[0];
		const removal = heard[2]?.[0];

		expect(insertion?.do.op).toBe("add");
		expect(insertion?.do.path[0]).toBe("map");
		expect(isSameIdentity(insertion?.do.path[1] as object, key)).toBe(true);
		expect(insertion?.do.op === "add" && "slot" in insertion.do ? insertion.do.slot : undefined).toBe(0);
		expect(replacement?.do).toMatchObject({ op: "replace", path: ["map", expect.any(Object)], value: 2 });
		expect(removal?.do).toMatchObject({ op: "remove", path: ["map", expect.any(Object)] });
		expect(removal?.undo).toMatchObject({ op: "add", path: ["map", expect.any(Object)], slot: 0, value: 2 });
	});

	it("emits key interiors through keyOf and value interiors through the key", () => {
		const key = { profile: { id: 1 } };
		const value = { count: 1 };
		// Heavy unchanged padding keeps two small interiors atomic so the keyOf path shape stays observable.
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
			const mutableKey = [...mutable.map.keys()][0] as typeof key;
			const mutableValue = mutable.map.get(key) as typeof value | undefined;

			if (!mutableKey || !mutableValue) throw new Error("missing entry");
			mutableKey.profile.id = 2;
			mutableValue.count = 2;
		});

		const ops = heard[0] ?? [];

		expect(getPathSelector(ops[0]?.do.path[1])?.kind).toBe("keyOf");
		expect(ops[0]?.do.path[2]).toBe("profile");
		expect(isSameIdentity(ops[1]?.do.path[1] as object, key)).toBe(true);
		expect(ops[1]?.do.path[2]).toBe("count");
	});

	it("round-trips clear and delete-readd through one collapsed container replace", () => {
		const state = createState({ map: new TrackedMap([["a", 1], ["b", 2]]) });
		const heard = record(state);

		state.mutate((mutable) => {
			mutable.map.clear();
			mutable.map.set("b", 20);
			mutable.map.set("a", 10);
		});

		const ops = heard[0] ?? [];

		expect(ops).toHaveLength(1);
		expect(ops[0]?.do).toMatchObject({ op: "replace", path: ["map"] });
		applyOps(state, [...ops].reverse().map((pair) => pair.undo));
		expect([...state.op.unwrap().map]).toEqual([["a", 1], ["b", 2]]);
		applyOps(state, ops.map((pair) => pair.do));
		expect([...state.op.unwrap().map]).toEqual([["b", 20], ["a", 10]]);
	});

	it("preserves object-key identity and aliased values through replay", () => {
		const key = { id: 1 };
		const shared = { count: 1 };
		const state = createState({ map: new TrackedMap([[key, shared], [{ id: 2 }, shared]]) });
		const selection = new Map([[identify(key), "selected"]]);
		const heard = record(state);

		state.mutate((mutable) => mutable.map.clear());
		const ops = heard[0] ?? [];
		applyOps(state, [...ops].reverse().map((pair) => pair.undo));

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
		applyOps(state, [...ops].reverse().map((pair) => pair.undo));
		expect(state.op.unwrap().map.get("a")?.items).toEqual(["x"]);
		expect(state.op.unwrap().map.get("a")?.when.getTime()).toBe(0);
		applyOps(state, ops.map((pair) => pair.do));
		expect(state.op.unwrap().map.get("a")?.items).toEqual(["x", "y"]);
		expect(state.op.unwrap().map.get("a")?.when.getTime()).toBe(1);
	});
});
