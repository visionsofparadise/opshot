import { createState, type Emission, type State } from "../createState";
import { applyOps } from "../ops/applyOps";
import type { Op, Operation } from "../ops/operation";
import { TrackedSet } from "./trackedSet";

const readField = (half: Operation | undefined, field: "member" | "members"): unknown => (half !== undefined && field in half ? Reflect.get(half, field) : undefined);

const recordAll = (state: State<object>): Array<{ ops: Array<Op>; emission: Emission }> => {
  const heard = new Array<{ ops: Array<Op>; emission: Emission }>();

  state.op.subscribe((_state, ops, emission) => {
    heard.push({ ops, emission });
  });

  return heard;
};

describe("tracked wrapper interface", () => {
  it("keeps TrackedSet a real Set: instanceof, size, membership, spread", () => {
    const set = new TrackedSet<number>([1, 2, 3]);

    expect(set).toBeInstanceOf(Set);
    expect(set).toBeInstanceOf(TrackedSet);
    expect(set.size).toBe(3);
    expect(set.has(2)).toBe(true);
    expect([...set]).toEqual([1, 2, 3]);
  });
});

describe("tracked wrapper addressing", () => {
  it("inverts per-member setAdd/setDelete pairs through applyOps replay", () => {
    const state = createState({ tags: new TrackedSet<number>([1, 2]) });
    const heard = recordAll(state);

    state.mutate((mutable) => {
      mutable.tags.add(3);
    });

    const addPair = heard[0]?.ops[0];

    if (!addPair) throw new Error("the setAdd pair was not heard");

    expect(heard[0]?.ops).toHaveLength(1);
    expect(addPair.isPatch).toBe(true);
    expect(addPair.do.op).toBe("setAdd");
    expect(addPair.do.path).toBe("/tags");
    expect(readField(addPair.do, "member")).toBe(3);
    expect(addPair.undo.op).toBe("setDelete");
    expect(addPair.undo.path).toBe("/tags");
    expect(readField(addPair.undo, "member")).toBe(3);

    applyOps(state, [addPair.undo]);

    expect([...state.op.unwrap().tags]).toEqual([1, 2]);

    state.mutate((mutable) => {
      mutable.tags.delete(1);
    });

    const deletePair = heard[2]?.ops[0];

    if (!deletePair) throw new Error("the setDelete pair was not heard");

    expect(deletePair.do.op).toBe("setDelete");
    expect(readField(deletePair.do, "member")).toBe(1);
    expect(deletePair.undo.op).toBe("setAdd");
    expect(readField(deletePair.undo, "member")).toBe(1);

    applyOps(state, [deletePair.undo]);

    expect(state.op.unwrap().tags.has(1)).toBe(true);
  });

  it("addresses object members by identity on replay, so replaying a delete removes the member instead of missing it", () => {
    const member = { id: 1 };
    const state = createState({ tags: new TrackedSet<{ id: number }>([member]) });
    const heard = recordAll(state);

    state.mutate((mutable) => {
      mutable.tags.delete(member);
    });

    const doHalf = heard[0]?.ops[0]?.do;

    if (doHalf?.op !== "setDelete") throw new Error("the setDelete pair was not heard");

    // The op carries the live member reference, not a clone.
    expect(doHalf.member).toBe(member);

    // Restore the same reference, then replay the captured delete: identity addressing must remove it;
    // a cloned member would miss and leave the member in the set.
    state.mutate((mutable) => {
      mutable.tags.add(member);
    });
    applyOps(state, [doHalf]);

    expect(state.op.unwrap().tags.has(member)).toBe(false);
    expect(state.op.unwrap().tags.size).toBe(0);
  });

  it("emits whole-representation setEntries pairs only for clear", () => {
    const state = createState({ tags: new TrackedSet<number>([1, 2]) });
    const heard = recordAll(state);

    state.mutate((mutable) => {
      mutable.tags.clear();
    });

    const pair = heard[0]?.ops[0];

    if (!pair) throw new Error("the setEntries pair was not heard");

    expect(heard[0]?.ops).toHaveLength(1);
    expect(pair.isPatch).toBe(true);
    expect(pair.do.op).toBe("setEntries");
    expect(pair.do.path).toBe("/tags");
    expect(readField(pair.do, "members")).toEqual([]);
    expect(pair.undo.op).toBe("setEntries");
    expect(pair.undo.path).toBe("/tags");
    expect(readField(pair.undo, "members")).toEqual([1, 2]);

    applyOps(state, [pair.undo]);

    expect([...state.op.unwrap().tags]).toEqual([1, 2]);
  });
});
