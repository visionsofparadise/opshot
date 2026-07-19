import { createState, type Emission, type State } from "../createState";
import { TrackedDate } from "../tracked/trackedDate";
import { TrackedMap } from "../tracked/trackedMap";
import { TrackedSet } from "../tracked/trackedSet";
import { applyOps } from "./applyOps";
import { createMapSetOperation, createValueOperation, type Op, type Operation } from "./operation";

const recordAll = (state: State<object>): Array<{ ops: Array<Op>; emission: Emission }> => {
  const heard = new Array<{ ops: Array<Op>; emission: Emission }>();

  state.op.subscribe((_state, ops, emission) => {
    heard.push({ ops, emission });
  });

  return heard;
};

const firstOps = (heard: Array<{ ops: Array<Op>; emission: Emission }>): Array<Op> => {
  const ops = heard[0]?.ops;

  if (!ops) throw new Error("no ops were heard");

  return ops;
};

describe("applyOps", () => {
  it("round-trips a plain mutation: reversed undo halves restore the original, do halves restore the mutated", () => {
    const state = createState({ title: "a", items: [1, 2] });
    const heard = recordAll(state);
    const original = state.op.unwrap();

    state.mutate((mutable) => {
      mutable.title = "b";
      mutable.items.push(3);
    });

    const mutated = state.op.unwrap();
    const ops = firstOps(heard);

    applyOps(state, [...ops].reverse().map((op) => op.undo));

    expect(state.op.unwrap()).toEqual(original);

    applyOps(state, ops.map((op) => op.do));

    expect(state.op.unwrap()).toEqual(mutated);
  });

  it("round-trips string-keyed TrackedMap operations through wrapper methods", () => {
    const state = createState({ map: new TrackedMap<string, number>([["a", 1]]) });
    const heard = recordAll(state);

    state.mutate((mutable) => {
      mutable.map.set("a", 2);
      mutable.map.set("b", 9);
      mutable.map.delete("a");
    });

    const ops = firstOps(heard);

    applyOps(state, [...ops].reverse().map((op) => op.undo));

    expect([...state.op.unwrap().map]).toEqual([["a", 1]]);

    applyOps(state, ops.map((op) => op.do));

    expect([...state.op.unwrap().map]).toEqual([["b", 9]]);
  });

  it("round-trips object-keyed TrackedMap operations, addressing the entry by key identity", () => {
    const key = { id: 1 };
    const state = createState({ lookup: new TrackedMap<{ id: number }, string>([[key, "one"]]) });
    const heard = recordAll(state);

    state.mutate((mutable) => {
      mutable.lookup.set(key, "two");
    });

    const ops = firstOps(heard);

    applyOps(state, [...ops].reverse().map((op) => op.undo));

    expect(state.op.unwrap().lookup.size).toBe(1);
    expect(state.op.unwrap().lookup.get(key)).toBe("one");

    applyOps(state, ops.map((op) => op.do));

    expect(state.op.unwrap().lookup.size).toBe(1);
    expect(state.op.unwrap().lookup.get(key)).toBe("two");
  });

  it("round-trips object-membered TrackedSet operations, addressing the member by identity", () => {
    const member = { id: 1 };
    const state = createState({ tags: new TrackedSet<{ id: number }>([member]) });
    const heard = recordAll(state);

    state.mutate((mutable) => {
      mutable.tags.delete(member);
    });

    const ops = firstOps(heard);

    applyOps(state, [...ops].reverse().map((op) => op.undo));

    expect(state.op.unwrap().tags.size).toBe(1);
    expect(state.op.unwrap().tags.has(member)).toBe(true);

    applyOps(state, ops.map((op) => op.do));

    expect(state.op.unwrap().tags.size).toBe(0);
  });

  it("round-trips primitive TrackedSet operations", () => {
    const state = createState({ tags: new TrackedSet<number>([1, 2]) });
    const heard = recordAll(state);

    state.mutate((mutable) => {
      mutable.tags.add(3);
      mutable.tags.delete(1);
    });

    const ops = firstOps(heard);

    applyOps(state, [...ops].reverse().map((op) => op.undo));

    // Method replay restores membership, not insertion order: re-adding 1 appends it.
    expect([...state.op.unwrap().tags].sort()).toEqual([1, 2]);

    applyOps(state, ops.map((op) => op.do));

    expect([...state.op.unwrap().tags].sort()).toEqual([2, 3]);
  });

  it("round-trips a TrackedDate epoch pair", () => {
    const state = createState({ when: new TrackedDate(Date.UTC(2020, 0, 1)) });
    const heard = recordAll(state);

    state.mutate((mutable) => {
      mutable.when.setUTCFullYear(2024);
    });

    const ops = firstOps(heard);

    applyOps(state, [...ops].reverse().map((op) => op.undo));

    expect(state.op.unwrap().when.getTime()).toBe(Date.UTC(2020, 0, 1));

    applyOps(state, ops.map((op) => op.do));

    expect(state.op.unwrap().when.getTime()).toBe(Date.UTC(2024, 0, 1));
  });

  it("round-trips clear through the entries variants for TrackedMap and TrackedSet", () => {
    const state = createState({
      map: new TrackedMap<string, number>([
        ["a", 1],
        ["b", 2],
      ]),
      tags: new TrackedSet<number>([1, 2]),
    });
    const heard = recordAll(state);

    state.mutate((mutable) => {
      mutable.map.clear();
      mutable.tags.clear();
    });

    const ops = firstOps(heard);

    applyOps(state, [...ops].reverse().map((op) => op.undo));

    expect([...state.op.unwrap().map]).toEqual([
      ["a", 1],
      ["b", 2],
    ]);
    expect([...state.op.unwrap().tags]).toEqual([1, 2]);

    applyOps(state, ops.map((op) => op.do));

    expect(state.op.unwrap().map.size).toBe(0);
    expect(state.op.unwrap().tags.size).toBe(0);
  });

  it("forwards meta to the emission: a recorder skips the replay while persistence hears it", () => {
    const state = createState({ count: 0 });
    const recorded = new Array<Array<Op>>();
    const persisted = new Array<Record<string, unknown>>();

    state.op.subscribe((_state, ops, emission: Emission<{ replay?: boolean }>) => {
      if (!emission.isSideEffect && emission.meta.replay !== true) recorded.push(ops);
    });
    state.op.subscribe((_state, _ops, emission: Emission<{ replay?: boolean }>) => {
      if (!emission.isSideEffect) persisted.push(emission.meta);
    });

    state.mutate((mutable) => {
      mutable.count = 1;
    });

    const ops = recorded[0];

    if (!ops) throw new Error("no ops were recorded");

    applyOps(state, [...ops].reverse().map((op) => op.undo), { replay: true });

    expect(state.op.unwrap().count).toBe(0);
    expect(recorded).toHaveLength(1);
    expect(persisted).toEqual([{}, { replay: true }]);
  });

  it("throws on a copied half: spread and JSON copies are brandless", () => {
    const state = createState({ count: 0 });
    const heard = recordAll(state);

    state.mutate((mutable) => {
      mutable.count = 1;
    });

    const half = firstOps(heard)[0]?.undo;

    if (!half) throw new Error("no undo half was heard");

    const copyMessage = "opshot: this op is a copy (spread, JSON, or structuredClone) and has lost its value. Apply the op objects the listener delivered; never copy them.";

    expect(() => applyOps(state, [{ ...half }])).toThrow(copyMessage);
    expect(() => applyOps(state, [JSON.parse(JSON.stringify(half)) as Operation])).toThrow(copyMessage);
    expect(state.op.unwrap().count).toBe(1);
  });

  it("throws on an envelope and on a marker: an isPatch field is not an operation half", () => {
    const state = createState({ count: 0 });
    const heard = recordAll(state);

    state.mutate((mutable) => {
      mutable.count = 1;
    });

    const envelope = firstOps(heard)[0];

    if (!envelope) throw new Error("no op was heard");

    const markerMessage =
      "opshot: applyOps applies operation halves; pass op.do or op.undo. A marker (isPatch: false) is a notification and cannot be applied; project the value's state into plain fields instead.";

    expect(() => applyOps(state, [envelope as unknown as Operation])).toThrow(markerMessage);
    expect(() => applyOps(state, [{ isPatch: false, changed: "/count" } as unknown as Operation])).toThrow(markerMessage);
    expect(state.op.unwrap().count).toBe(1);
  });

  it("throws when a wrapper operation's pointer does not resolve to a tracked wrapper", () => {
    const state = createState({ plain: { a: 1 } });

    expect(() => applyOps(state, [createMapSetOperation("/plain", "k", 1)])).toThrow("opshot: /plain does not resolve to a Tracked<Map|Set|Date>");
  });

  it("round-trips a mutation touching plain data and a wrapper in one mutate", () => {
    const state = createState({ count: 0, map: new TrackedMap<string, number>([["a", 1]]) });
    const heard = recordAll(state);

    state.mutate((mutable) => {
      mutable.count = 1;
      mutable.map.set("a", 2);
    });

    const ops = firstOps(heard);

    applyOps(state, [...ops].reverse().map((op) => op.undo));

    expect(state.op.unwrap().count).toBe(0);
    expect(state.op.unwrap().map.get("a")).toBe(1);

    applyOps(state, ops.map((op) => op.do));

    expect(state.op.unwrap().count).toBe(1);
    expect(state.op.unwrap().map.get("a")).toBe(2);
  });

  it("applies interleaved plain and wrapper operations in order: a wrapper op after a replace addresses the replacement", () => {
    const replacement = new TrackedMap<string, number>();
    const state = createState({ map: new TrackedMap<string, number>([["k", 1]]) });
    const original = state.op.unwrap().map;

    applyOps(state, [createValueOperation("replace", "/map", replacement), createMapSetOperation("/map", "k", 2)]);

    expect(state.op.unwrap().map.get("k")).toBe(2);
    expect(original.get("k")).toBe(1);
  });
});
