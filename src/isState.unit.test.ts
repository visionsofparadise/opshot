import { createGroup } from "./createGroup";
import { createState, type State } from "./createState";
import { isState } from "./isState";

interface Counter {
  count: number;
  increment: () => void;
}

const createCounter = (): State<Counter> =>
  createState<Counter>((mutate) => ({
    count: 0,
    increment: () => {
      mutate((mutable) => {
        mutable.count += 1;
      });
    },
  }));

const createTrackedCounter = (): { state: State<Counter>; emissions: Array<State<object>> } => {
  const group = createGroup();
  const emissions = new Array<State<object>>();

  group.subscribe((state) => {
    emissions.push(state);
  });

  const state = group.createState<Counter>((mutate) => ({
    count: 0,
    increment: () => {
      mutate((mutable) => {
        mutable.count += 1;
      });
    },
  }));

  return { state, emissions };
};

describe("isState", () => {
  it("recognizes states and rejects other values", () => {
    expect(isState(createCounter())).toBe(true);
    expect(isState({ count: 1 })).toBe(false);
    expect(isState({ op: { unsafeMutable: 1 } })).toBe(false);
    expect(isState(null)).toBe(false);
    expect(isState(undefined)).toBe(false);
    expect(isState("state")).toBe(false);
  });

  it("rejects a foreign object shaped like a state, which the old duck-check accepted", () => {
    expect(isState({ op: { unsafeMutable: {} } })).toBe(false);
  });

  it("keeps isState true on the fresh generation a subscriber receives after a mutation", () => {
    const { state, emissions } = createTrackedCounter();

    state.increment();

    const current = emissions[0];

    if (!current) throw new Error("the group heard no emission");

    expect(current).not.toBe(state);
    expect(isState(current)).toBe(true);
  });
});
