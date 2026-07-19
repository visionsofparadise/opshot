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

// Per-field asserts: branded halves carry prototype getters whole-object toEqual cannot see.
const expectMapSetAddPair = (op: Op | undefined, path: string, key: unknown, value: unknown): void => {
  if (!op) throw new Error("the pair was not heard");

  expect(op.isPatch).toBe(true);

  if (op.do.op !== "mapSet" || op.undo.op !== "mapDelete") throw new Error(`expected a mapSet/mapDelete pair, heard ${op.do.op}/${op.undo.op}`);

  expect(op.do.path).toBe(path);
  expect(op.do.key).toBe(key);
  expect(op.do.value).toBe(value);
  expect(op.undo.path).toBe(path);
  expect(op.undo.key).toBe(key);
};

describe("tracked wrapper brand", () => {
  it("keeps the brand off object-spread copies while isTrackedWrapper still reads it", () => {
    const map = new TrackedMap<string, number>([["a", 1]]);
    const set = new TrackedSet<number>([1]);
    const date = new TrackedDate(0);

    for (const wrapper of [map, set, date]) {
      expect(Object.getOwnPropertySymbols({ ...wrapper })).not.toContain(trackedBrand);
      expect(isTrackedWrapper(wrapper)).toBe(true);
    }

    expect(map).toBeInstanceOf(Map);
    expect(set).toBeInstanceOf(Set);
    expect(date).toBeInstanceOf(Date);
  });
});

describe("tracked wrapper attachment", () => {
  it("pays no pair-building while unattached", () => {
    const getSpy = vi.spyOn(Map.prototype, "get");
    const hasSpy = vi.spyOn(Map.prototype, "has");
    const entriesSpy = vi.spyOn(Map.prototype, "entries");

    try {
      const map = new TrackedMap<string, number>([["seed", 0]]);

      map.set("a", 1);
      map.set("a", 2);
      map.delete("a");
      map.clear();

      expect(getSpy).not.toHaveBeenCalled();
      expect(hasSpy).not.toHaveBeenCalled();
      expect(entriesSpy).not.toHaveBeenCalled();
    } finally {
      getSpy.mockRestore();
      hasSpy.mockRestore();
      entriesSpy.mockRestore();
    }
  });
});

describe("tracked wrapper emission routing", () => {
  it("joins the owning mutate's emission with the caller's meta, and the flush adds nothing", async () => {
    const state = createState({ map: new TrackedMap<string, number>() });
    const heard = recordAll(state);

    state.mutate(
      (mutable) => {
        mutable.map.set("a", 1);
      },
      { reason: "wrapper" },
    );

    expect(heard).toHaveLength(1);
    expect(heard[0]?.emission).toEqual({ isSideEffect: false, meta: { reason: "wrapper" } });
    expect(heard[0]?.ops).toHaveLength(1);
    expectMapSetAddPair(heard[0]?.ops[0], "/map", "a", 1);

    await Promise.resolve();

    expect(heard).toHaveLength(1);
  });

  it("merges wrapper ops after the diff's ops in one owned emission", () => {
    const state = createState({ count: 0, map: new TrackedMap<string, number>() });
    const heard = recordAll(state);

    state.mutate((mutable) => {
      mutable.count = 1;
      mutable.map.set("b", 2);
    });

    expect(heard).toHaveLength(1);
    expect(heard[0]?.ops).toHaveLength(2);
    expect(heard[0]?.ops[0]).toEqual({ isPatch: true, do: { op: "replace", path: "/count", value: 1 }, undo: { op: "replace", path: "/count", value: 0 } });
    expectMapSetAddPair(heard[0]?.ops[1], "/map", "b", 2);
  });

  it("prefixes the wrapper's pointer through nested parents", () => {
    const state = createState({ inner: { map: new TrackedMap<string, number>() } });
    const heard = recordAll(state);

    state.mutate((mutable) => {
      mutable.inner.map.set("k", 5);
    });

    expect(heard).toHaveLength(1);
    expect(heard[0]?.ops).toHaveLength(1);
    expectMapSetAddPair(heard[0]?.ops[0], "/inner/map", "k", 5);
  });

  it("emits a mutation outside mutate as a side effect on the flush", async () => {
    const state = createState({ map: new TrackedMap<string, number>() });
    const heard = recordAll(state);

    state.map.set("a", 1);

    expect(heard).toHaveLength(0);

    await Promise.resolve();

    expect(heard).toHaveLength(1);
    expect(heard[0]?.emission).toEqual({ isSideEffect: true });
    expect(heard[0]?.ops).toHaveLength(1);
    expectMapSetAddPair(heard[0]?.ops[0], "/map", "a", 1);
  });

  it("tracks external code mutating through a plain Map-typed reference", async () => {
    const state = createState({ map: new TrackedMap<string, number>() });
    const heard = recordAll(state);
    const plain: Map<string, number> = state.map;

    plain.set("x", 9);

    await Promise.resolve();

    expect(heard).toHaveLength(1);
    expect(heard[0]?.emission).toEqual({ isSideEffect: true });
    expect(heard[0]?.ops).toHaveLength(1);
    expectMapSetAddPair(heard[0]?.ops[0], "/map", "x", 9);
  });

  it("leaves the generic-method bypass untracked", async () => {
    const state = createState({ map: new TrackedMap<string, number>() });
    const heard = recordAll(state);

    Map.prototype.set.call(state.map, "ghost", 1);

    await Promise.resolve();

    expect(heard).toHaveLength(0);
    expect(state.map.get("ghost")).toBe(1);
  });

  it("attaches once for a key: delete-then-reassign does not double-emit", async () => {
    const held = new TrackedMap<string, number>();
    const state = createState<{ map?: TrackedMap<string, number> }>({ map: held });
    const heard = recordAll(state);

    state.mutate((mutable) => {
      delete mutable.map;
      mutable.map = held;
    });

    state.mutate((mutable) => {
      mutable.map?.set("z", 1);
    });

    await Promise.resolve();

    expect(heard).toHaveLength(1);
    expect(heard[0]?.emission).toEqual({ isSideEffect: false, meta: {} });
    expect(heard[0]?.ops).toHaveLength(1);
    expectMapSetAddPair(heard[0]?.ops[0], "/map", "z", 1);
  });

  it("attaches a wrapper assigned after creation through the set trap", () => {
    const state = createState<{ slot?: TrackedMap<string, number> }>({});
    const heard = recordAll(state);
    const map = new TrackedMap<string, number>();

    state.mutate((mutable) => {
      mutable.slot = map;
    });

    state.mutate((mutable) => {
      mutable.slot?.set("k", 1);
    });

    expect(heard).toHaveLength(2);
    expect(heard[0]?.ops).toEqual([{ isPatch: true, do: { op: "add", path: "/slot", value: map }, undo: { op: "remove", path: "/slot" } }]);
    expect(heard[1]?.ops).toHaveLength(1);
    expectMapSetAddPair(heard[1]?.ops[0], "/slot", "k", 1);
  });
});
