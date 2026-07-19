import { createState, type Emission, type State } from "./createState";
import type { Op, PatchOperation } from "./diff";
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

describe("tracked wrapper interface", () => {
  it("keeps TrackedMap a real Map: instanceof, size, reads, iteration, spread", () => {
    const map = new TrackedMap<string, number>([
      ["a", 1],
      ["b", 2],
    ]);

    expect(map).toBeInstanceOf(Map);
    expect(map).toBeInstanceOf(TrackedMap);
    expect(map.size).toBe(2);
    expect(map.get("a")).toBe(1);
    expect(map.has("b")).toBe(true);
    expect([...map]).toEqual([
      ["a", 1],
      ["b", 2],
    ]);
    expect([...map.keys()]).toEqual(["a", "b"]);
    expect([...map.values()]).toEqual([1, 2]);
  });

  it("keeps TrackedSet a real Set: instanceof, size, membership, spread", () => {
    const set = new TrackedSet<number>([1, 2, 3]);

    expect(set).toBeInstanceOf(Set);
    expect(set).toBeInstanceOf(TrackedSet);
    expect(set.size).toBe(3);
    expect(set.has(2)).toBe(true);
    expect([...set]).toEqual([1, 2, 3]);
  });

  it("keeps TrackedDate a real Date: instanceof, getters, formatting", () => {
    const date = new TrackedDate(Date.UTC(2020, 0, 1));

    expect(date).toBeInstanceOf(Date);
    expect(date).toBeInstanceOf(TrackedDate);
    expect(date.getTime()).toBe(Date.UTC(2020, 0, 1));
    expect(date.getUTCFullYear()).toBe(2020);
    expect(date.toISOString()).toBe("2020-01-01T00:00:00.000Z");
  });

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

    expect(heard).toEqual([
      {
        ops: [{ isPatch: true, do: { op: "add", path: "/map/a", value: 1 }, undo: { op: "remove", path: "/map/a" } }],
        emission: { isSideEffect: false, meta: { reason: "wrapper" } },
      },
    ]);

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
    expect(heard[0]?.ops).toEqual([
      { isPatch: true, do: { op: "replace", path: "/count", value: 1 }, undo: { op: "replace", path: "/count", value: 0 } },
      { isPatch: true, do: { op: "add", path: "/map/b", value: 2 }, undo: { op: "remove", path: "/map/b" } },
    ]);
  });

  it("prefixes the wrapper's pointer through nested parents", () => {
    const state = createState({ inner: { map: new TrackedMap<string, number>() } });
    const heard = recordAll(state);

    state.mutate((mutable) => {
      mutable.inner.map.set("k", 5);
    });

    expect(heard).toHaveLength(1);
    expect(heard[0]?.ops).toEqual([{ isPatch: true, do: { op: "add", path: "/inner/map/k", value: 5 }, undo: { op: "remove", path: "/inner/map/k" } }]);
  });

  it("emits a mutation outside mutate as a side effect on the flush", async () => {
    const state = createState({ map: new TrackedMap<string, number>() });
    const heard = recordAll(state);

    state.map.set("a", 1);

    expect(heard).toHaveLength(0);

    await Promise.resolve();

    expect(heard).toEqual([
      {
        ops: [{ isPatch: true, do: { op: "add", path: "/map/a", value: 1 }, undo: { op: "remove", path: "/map/a" } }],
        emission: { isSideEffect: true },
      },
    ]);
  });

  it("tracks external code mutating through a plain Map-typed reference", async () => {
    const state = createState({ map: new TrackedMap<string, number>() });
    const heard = recordAll(state);
    const plain: Map<string, number> = state.map;

    plain.set("x", 9);

    await Promise.resolve();

    expect(heard).toEqual([
      {
        ops: [{ isPatch: true, do: { op: "add", path: "/map/x", value: 9 }, undo: { op: "remove", path: "/map/x" } }],
        emission: { isSideEffect: true },
      },
    ]);
  });

  it("leaves the generic-method bypass untracked", async () => {
    // Documented residue: a generic call writes the inherited slots without entering the override,
    // the generic-call equivalent of an untrapped write. See design-architecture.md, tracked wrappers.
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

    expect(heard).toEqual([
      {
        ops: [{ isPatch: true, do: { op: "add", path: "/map/z", value: 1 }, undo: { op: "remove", path: "/map/z" } }],
        emission: { isSideEffect: false, meta: {} },
      },
    ]);
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
    expect(heard[1]?.ops).toEqual([{ isPatch: true, do: { op: "add", path: "/slot/k", value: 1 }, undo: { op: "remove", path: "/slot/k" } }]);
  });
});

describe("tracked wrapper addressing", () => {
  // The README recipe: wrapper ops are records replayed through wrapper methods, never applyPatch
  // targets. A per-key patch's key is its last pointer segment, RFC 6901-unescaped.
  const lastSegment = (pointer: string, prefix: string): string => pointer.slice(prefix.length + 1).replaceAll("~1", "/").replaceAll("~0", "~");

  const applyToMap = (map: TrackedMap<string, number>, patch: PatchOperation): void => {
    const key = lastSegment(patch.path, "/map");

    if (patch.op === "remove") map.delete(key);
    else map.set(key, patch.value as number);
  };

  it("inverts string-keyed per-key pairs through the recipe, escaping included", () => {
    const state = createState({ map: new TrackedMap<string, number>([["a/b", 1]]) });
    const heard = recordAll(state);

    state.mutate((mutable) => {
      mutable.map.set("a/b", 2);
    });

    expect(heard[0]?.ops).toEqual([
      { isPatch: true, do: { op: "replace", path: "/map/a~1b", value: 2 }, undo: { op: "replace", path: "/map/a~1b", value: 1 } },
    ]);

    const replaceUndo = heard[0]?.ops[0]?.undo;

    if (!replaceUndo) throw new Error("the replace pair was not heard");

    state.mutate((mutable) => {
      applyToMap(mutable.map, replaceUndo);
    });

    expect(state.op.unwrap().map.get("a/b")).toBe(1);

    state.mutate((mutable) => {
      mutable.map.delete("a/b");
    });

    expect(heard[2]?.ops).toEqual([{ isPatch: true, do: { op: "remove", path: "/map/a~1b" }, undo: { op: "add", path: "/map/a~1b", value: 1 } }]);

    const deleteUndo = heard[2]?.ops[0]?.undo;

    if (!deleteUndo) throw new Error("the delete pair was not heard");

    state.mutate((mutable) => {
      applyToMap(mutable.map, deleteUndo);
    });

    expect(state.op.unwrap().map.get("a/b")).toBe(1);
  });

  it("emits whole-representation member pairs for Set mutations", () => {
    const state = createState({ tags: new TrackedSet<number>([1, 2]) });
    const heard = recordAll(state);

    state.mutate((mutable) => {
      mutable.tags.add(3);
    });

    expect(heard[0]?.ops).toEqual([
      { isPatch: true, do: { op: "replace", path: "/tags", value: [1, 2, 3] }, undo: { op: "replace", path: "/tags", value: [1, 2] } },
    ]);

    state.mutate((mutable) => {
      mutable.tags.clear();
    });

    expect(heard[1]?.ops).toEqual([
      { isPatch: true, do: { op: "replace", path: "/tags", value: [] }, undo: { op: "replace", path: "/tags", value: [1, 2, 3] } },
    ]);
  });

  it("emits whole-representation entries pairs for non-string Map keys", () => {
    const state = createState({ lookup: new TrackedMap<number, string>([[1, "one"]]) });
    const heard = recordAll(state);

    state.mutate((mutable) => {
      mutable.lookup.set(2, "two");
    });

    expect(heard[0]?.ops).toEqual([
      {
        isPatch: true,
        do: {
          op: "replace",
          path: "/lookup",
          value: [
            [1, "one"],
            [2, "two"],
          ],
        },
        undo: { op: "replace", path: "/lookup", value: [[1, "one"]] },
      },
    ]);
  });

  it("emits a scalar epoch replace pair for TrackedDate setters", () => {
    const state = createState({ when: new TrackedDate(Date.UTC(2020, 0, 1)) });
    const heard = recordAll(state);

    state.mutate((mutable) => {
      mutable.when.setUTCFullYear(2024);
    });

    expect(heard).toEqual([
      {
        ops: [
          {
            isPatch: true,
            do: { op: "replace", path: "/when", value: Date.UTC(2024, 0, 1) },
            undo: { op: "replace", path: "/when", value: Date.UTC(2020, 0, 1) },
          },
        ],
        emission: { isSideEffect: false, meta: {} },
      },
    ]);
  });
});
