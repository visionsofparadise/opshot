import { createState, type Emission, type State } from "../createState";
import type { Op } from "../ops/operation";
import { TrackedDate } from "./trackedDate";
import { TrackedMap } from "./trackedMap";
import { TrackedSet } from "./trackedSet";
import { isTrackedWrapper, trackedBrand } from "./trackedWrapper";

const recordAll = (state: State<object>): Array<{ ops: Array<Op>; emission: Emission }> => {
	const heard = new Array<{ ops: Array<Op>; emission: Emission }>();

	state.op.subscribe((_state, ops, emission) => {
		heard.push({ ops, emission });
	});

	return heard;
};

describe("tracked facade brand", () => {
	it("brands shared prototypes and preserves the brand through proxy snapshots", () => {
		const map = new TrackedMap<string, number>([["a", 1]]);
		const set = new TrackedSet<number>([1]);
		const date = new TrackedDate(0);

		for (const facade of [map, set, date]) {
			expect(Object.hasOwn(facade, trackedBrand)).toBe(false);
			expect(Object.getOwnPropertySymbols({ ...facade })).not.toContain(trackedBrand);
			expect(isTrackedWrapper(facade)).toBe(true);
		}

		const state = createState({ date, map, set });
		const snapshot = state.op.unwrap();

		expect(isTrackedWrapper(snapshot.map)).toBe(true);
		expect(isTrackedWrapper(snapshot.set)).toBe(true);
		expect(isTrackedWrapper(snapshot.date)).toBe(true);
		expect(Reflect.getPrototypeOf(snapshot.map)).toBe(TrackedMap.prototype);
		expect(Reflect.getPrototypeOf(snapshot.set)).toBe(TrackedSet.prototype);
		expect(Reflect.getPrototypeOf(snapshot.date)).toBe(TrackedDate.prototype);
	});

	it("admits facades assigned after creation and tracks mutations through their prototype methods", () => {
		const state = createState<{ map?: TrackedMap<string, number> }>({});
		const beforeAttach = state.op.unwrap();

		state.mutate((mutable) => {
			mutable.map = new TrackedMap();
		});

		const afterAttach = state.op.unwrap();

		state.mutate((mutable) => {
			mutable.map?.set("a", 1);
		});

		const afterMutation = state.op.unwrap();

		expect(afterAttach).not.toBe(beforeAttach);
		expect(afterMutation).not.toBe(afterAttach);
		expect(afterMutation.map?.get("a")).toBe(1);
	});
});

describe("tracked facade semantic emission (Phase 5)", () => {
	it("keeps an owned facade mutation in one meta-bearing emission with no watchdog echo", async () => {
		const state = createState({ map: new TrackedMap<string, number>() });
		const heard = recordAll(state);

		state.mutate(
			(mutable) => {
				mutable.map.set("a", 1);
			},
			{ reason: "facade" },
		);

		expect(heard).toHaveLength(1);
		expect(heard[0]?.emission).toEqual({ isSideEffect: false, meta: { reason: "facade" } });
		expect(heard[0]?.ops).toHaveLength(1);

		await Promise.resolve();

		expect(heard).toHaveLength(1);
	});

	it("emits a flat atomic add for an owned facade mutation", () => {
		const state = createState({ map: new TrackedMap<string, number>() });
		const heard = recordAll(state);

		state.mutate((mutable) => {
			mutable.map.set("a", 1);
		});

		expect(heard[0]?.ops[0]?.do).toMatchObject({ op: "add", path: ["map", "a"], slot: 0, value: 1 });
	});

	it("merges facade ops after the diff's ops in one owned emission", () => {
		const state = createState({ count: 0, map: new TrackedMap<string, number>() });
		const heard = recordAll(state);

		state.mutate((mutable) => {
			mutable.count = 1;
			mutable.map.set("b", 2);
		});

		expect(heard).toHaveLength(1);
		expect(heard[0]?.ops).toHaveLength(2);
		expect(heard[0]?.ops.map((op) => op.do.op)).toEqual(["replace", "add"]);
	});

	it("prefixes a nested facade's flat path", () => {
		const state = createState({ inner: { map: new TrackedMap<string, number>() } });
		const heard = recordAll(state);

		state.mutate((mutable) => {
			mutable.inner.map.set("k", 5);
		});

		expect(heard[0]?.ops[0]?.do).toMatchObject({ op: "add", path: ["inner", "map", "k"], value: 5, slot: 0 });
	});

	it("reports a facade mutation outside mutate once as a side effect on the flush", async () => {
		const state = createState({ map: new TrackedMap<string, number>() });
		const heard = recordAll(state);
		const mutable: unknown = Reflect.get(state.op.unsafeMutable, "map");

		if (!(mutable instanceof TrackedMap)) throw new Error("the mutable facade was not found");

		mutable.set("a", 1);

		expect(heard).toHaveLength(0);

		await Promise.resolve();

		expect(heard).toHaveLength(1);
		expect(heard[0]?.emission).toEqual({ isSideEffect: true });
		expect(heard[0]?.ops).toHaveLength(1);

		const pair = heard[0]?.ops[0];

		if (pair?.do.op !== "add" || pair.undo.op !== "remove") throw new Error("the facade side-effect pair was not heard");
		if (!("value" in pair.do)) throw new Error("the map addition has no value");

		expect(pair.do).toMatchObject({ path: ["map", "a"], slot: 0 });
		expect(pair.do.value).toBe(1);
		expect(pair.undo).toEqual({ op: "remove", path: ["map", "a"] });
	});

	it("emits semantic ops for a facade assigned after creation", () => {
		const state = createState<{ slot?: TrackedMap<string, number> }>({});
		const heard = recordAll(state);

		state.mutate((mutable) => {
			mutable.slot = new TrackedMap();
		});

		state.mutate((mutable) => {
			mutable.slot?.set("k", 1);
		});

		expect(heard).toHaveLength(2);
		expect(heard[0]?.ops[0]?.do.op).toBe("add");
		expect(heard[1]?.ops[0]?.do).toMatchObject({ op: "add", path: ["slot", "k"], value: 1, slot: 0 });
	});
});
