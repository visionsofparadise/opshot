import { createState, type Emission, type State } from "../createState";
import { applyOps } from "../ops/applyOps";
import type { Op, Operation } from "../ops/operation";
import { TrackedMap } from "./trackedMap";

const readField = (half: Operation | undefined, field: "key" | "value" | "entries"): unknown => (half !== undefined && field in half ? Reflect.get(half, field) : undefined);

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
});

describe("tracked wrapper addressing", () => {
  it("inverts per-key mapSet/mapDelete pairs through applyOps replay, unescaped keys included", () => {
    const state = createState({ map: new TrackedMap<string, number>([["a/b", 1]]) });
    const heard = recordAll(state);

    state.mutate((mutable) => {
      mutable.map.set("a/b", 2);
    });

    const setPair = heard[0]?.ops[0];

    if (!setPair) throw new Error("the set pair was not heard");

    expect(heard[0]?.ops).toHaveLength(1);
    expect(setPair.isPatch).toBe(true);
    expect(setPair.do.op).toBe("mapSet");
    expect(setPair.do.path).toBe("/map");
    expect(readField(setPair.do, "key")).toBe("a/b");
    expect(readField(setPair.do, "value")).toBe(2);
    expect(setPair.undo.op).toBe("mapSet");
    expect(setPair.undo.path).toBe("/map");
    expect(readField(setPair.undo, "key")).toBe("a/b");
    expect(readField(setPair.undo, "value")).toBe(1);

    applyOps(state, [setPair.undo]);

    expect(state.op.unwrap().map.get("a/b")).toBe(1);

    state.mutate((mutable) => {
      mutable.map.delete("a/b");
    });

    const deletePair = heard[2]?.ops[0];

    if (!deletePair) throw new Error("the delete pair was not heard");

    expect(deletePair.do.op).toBe("mapDelete");
    expect(deletePair.do.path).toBe("/map");
    expect(readField(deletePair.do, "key")).toBe("a/b");
    expect(deletePair.undo.op).toBe("mapSet");
    expect(readField(deletePair.undo, "key")).toBe("a/b");
    expect(readField(deletePair.undo, "value")).toBe(1);

    applyOps(state, [deletePair.undo]);

    expect(state.op.unwrap().map.get("a/b")).toBe(1);
  });

  it("emits per-key mapSet pairs for object keys", () => {
    const state = createState({ lookup: new TrackedMap<{ id: number }, string>() });
    const heard = recordAll(state);
    const key = { id: 1 };

    state.mutate((mutable) => {
      mutable.lookup.set(key, "one");
    });

    const pair = heard[0]?.ops[0];

    if (!pair) throw new Error("the mapSet pair was not heard");

    expect(heard[0]?.ops).toHaveLength(1);
    expect(pair.isPatch).toBe(true);
    expect(pair.do.op).toBe("mapSet");
    expect(pair.do.path).toBe("/lookup");
    expect(readField(pair.do, "key")).toEqual({ id: 1 });
    expect(readField(pair.do, "value")).toBe("one");
    expect(pair.undo.op).toBe("mapDelete");
    expect(pair.undo.path).toBe("/lookup");
    expect(readField(pair.undo, "key")).toEqual({ id: 1 });
  });

  it("addresses object keys by identity on replay, so an undo restores the entry instead of duplicating it", () => {
    const key = { id: 1 };
    const state = createState({ lookup: new TrackedMap<{ id: number }, string>([[key, "one"]]) });
    const heard = recordAll(state);

    state.mutate((mutable) => {
      mutable.lookup.set(key, "two");
    });

    const undo = heard[0]?.ops[0]?.undo;

    if (undo?.op !== "mapSet") throw new Error("the mapSet undo was not heard");

    expect(undo.key).toBe(key);

    applyOps(state, [undo]);

    expect(state.op.unwrap().lookup.size).toBe(1);
    expect(state.op.unwrap().lookup.get(key)).toBe("one");
  });

  it("emits whole-representation mapEntries pairs only for clear", () => {
    const state = createState({
      map: new TrackedMap<string, number>([
        ["a", 1],
        ["b", 2],
      ]),
    });
    const heard = recordAll(state);

    state.mutate((mutable) => {
      mutable.map.clear();
    });

    const pair = heard[0]?.ops[0];

    if (!pair) throw new Error("the mapEntries pair was not heard");

    expect(heard[0]?.ops).toHaveLength(1);
    expect(pair.isPatch).toBe(true);
    expect(pair.do.op).toBe("mapEntries");
    expect(pair.do.path).toBe("/map");
    expect(readField(pair.do, "entries")).toEqual([]);
    expect(pair.undo.op).toBe("mapEntries");
    expect(pair.undo.path).toBe("/map");
    expect(readField(pair.undo, "entries")).toEqual([
      ["a", 1],
      ["b", 2],
    ]);

    applyOps(state, [pair.undo]);

    expect([...state.op.unwrap().map]).toEqual([
      ["a", 1],
      ["b", 2],
    ]);
  });

  it("preserves cross-entry value aliasing through a clear undo", () => {
    const shared = { n: 1 };
    const state = createState({
      map: new TrackedMap<string, { host: { n: number } }>([
        ["a", { host: shared }],
        ["b", { host: shared }],
      ]),
    });
    const heard = recordAll(state);

    state.mutate((mutable) => {
      mutable.map.clear();
    });

    const undo = heard[0]?.ops[0]?.undo;

    if (undo?.op !== "mapEntries") throw new Error("the mapEntries undo was not heard");

    applyOps(state, [undo]);

    const restored = state.op.unwrap().map;
    const hostA = restored.get("a")?.host;
    const hostB = restored.get("b")?.host;

    expect(hostA).toBe(hostB);
  });

  it("captures values at emission: a later mutation of an aliased value cannot rewrite an undo half", () => {
    const shared = { n: 0 };
    const state = createState({ box: shared, map: new TrackedMap<string, { n: number }>([["k", shared]]) });
    const heard = recordAll(state);

    state.mutate((mutable) => {
      mutable.map.set("k", { n: 1 });
    });

    state.mutate((mutable) => {
      mutable.box.n = 99;
    });

    const firstUndo = heard[0]?.ops[0]?.undo;

    if (firstUndo?.op !== "mapSet") throw new Error("the mapSet undo was not heard");

    applyOps(state, [firstUndo]);

    expect(state.op.unwrap().map.get("k")).toEqual({ n: 0 });
  });
});
