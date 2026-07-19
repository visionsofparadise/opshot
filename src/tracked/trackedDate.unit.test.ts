import { createState, type Emission, type State } from "../createState";
import { applyOps } from "../ops/applyOps";
import type { Op, Operation } from "../ops/operation";
import { TrackedDate } from "./trackedDate";

const readEpoch = (half: Operation | undefined): unknown => (half !== undefined && "epoch" in half ? half.epoch : undefined);

const recordAll = (state: State<object>): Array<{ ops: Array<Op>; emission: Emission }> => {
  const heard = new Array<{ ops: Array<Op>; emission: Emission }>();

  state.op.subscribe((_state, ops, emission) => {
    heard.push({ ops, emission });
  });

  return heard;
};

describe("tracked wrapper interface", () => {
  it("keeps TrackedDate a real Date: instanceof, getters, formatting", () => {
    const date = new TrackedDate(Date.UTC(2020, 0, 1));

    expect(date).toBeInstanceOf(Date);
    expect(date).toBeInstanceOf(TrackedDate);
    expect(date.getTime()).toBe(Date.UTC(2020, 0, 1));
    expect(date.getUTCFullYear()).toBe(2020);
    expect(date.toISOString()).toBe("2020-01-01T00:00:00.000Z");
  });
});

describe("tracked wrapper addressing", () => {
  it("inverts a scalar dateSet epoch pair through applyOps replay", () => {
    const state = createState({ when: new TrackedDate(Date.UTC(2020, 0, 1)) });
    const heard = recordAll(state);

    state.mutate((mutable) => {
      mutable.when.setUTCFullYear(2024);
    });

    const pair = heard[0]?.ops[0];

    if (!pair) throw new Error("the dateSet pair was not heard");

    expect(heard[0]?.ops).toHaveLength(1);
    expect(heard[0]?.emission).toEqual({ isSideEffect: false, meta: {} });
    expect(pair.isPatch).toBe(true);
    expect(pair.do.op).toBe("dateSet");
    expect(pair.do.path).toBe("/when");
    expect(readEpoch(pair.do)).toBe(Date.UTC(2024, 0, 1));
    expect(pair.undo.op).toBe("dateSet");
    expect(pair.undo.path).toBe("/when");
    expect(readEpoch(pair.undo)).toBe(Date.UTC(2020, 0, 1));

    applyOps(state, [pair.undo]);

    expect(state.op.unwrap().when.getTime()).toBe(Date.UTC(2020, 0, 1));
  });
});
