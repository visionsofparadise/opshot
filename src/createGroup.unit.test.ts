import { createGroup } from "./createGroup";
import { createState, type MutateOptions, type State } from "./createState";
import { type Op } from "./diff";
import { unwrap } from "./unwrap";

interface Counter {
  count: number;
}

interface Emission {
  state: State<object>;
  ops: Array<Op>;
  options: MutateOptions;
}

const defineCounter = (): Counter => ({ count: 0 });

describe("createGroup", () => {
  it("hears every state it minted, with the state reference and options", () => {
    const group = createGroup();
    const emissions = new Array<Emission>();

    group.subscribe((state, ops, options) => {
      emissions.push({ state, ops, options });
    });

    const first = group.createState<Counter>(defineCounter);
    const second = group.createState<Counter>(defineCounter);

    first.op.mutate((draft) => {
      draft.count = 1;
    }, { transactionKey: "drag" });

    second.op.mutate((draft) => {
      draft.count = 2;
    });

    expect(emissions).toHaveLength(2);
    expect(first.op.isSameState(emissions[0]?.state)).toBe(true);
    expect(second.op.isSameState(emissions[0]?.state)).toBe(false);
    expect(emissions[0]?.ops).toEqual([
      { do: { op: "replace", path: "/count", value: 1 }, undo: { op: "replace", path: "/count", value: 0 } },
    ]);
    expect(emissions[0]?.options).toEqual({ transactionKey: "drag" });
    expect(second.op.isSameState(emissions[1]?.state)).toBe(true);
    expect(emissions[1]?.options).toEqual({});
  });

  it("carries the latest snapshot to the listener, not the proxy", () => {
    const group = createGroup();
    const emissions = new Array<Emission>();

    group.subscribe((state, ops, options) => {
      emissions.push({ state, ops, options });
    });

    const state = group.createState<Counter>(defineCounter);

    state.op.mutate((draft) => {
      draft.count = 1;
    });

    const received = emissions[0]?.state;

    if (!received) throw new Error("the group heard no emission");

    expect(received).not.toBe(state.op.proxy);
    expect(received).not.toBe(state);
    expect(state.op.isSameState(received)).toBe(true);
    expect(received).toEqual(expect.objectContaining({ count: 1 }));
    expect(() => {
      Object.assign(received, { count: 9 });
    }).toThrow(TypeError);
  });

  it("carries the snapshot its ops produced, not one a state listener wrote after them", () => {
    const group = createGroup();
    const emissions = new Array<Emission>();

    group.subscribe((state, ops, options) => {
      emissions.push({ state, ops, options });
    });

    const state = group.createState<Counter>(defineCounter);
    let reentered = false;

    state.op.subscribe(() => {
      if (reentered) return;

      reentered = true;

      state.op.mutate((draft) => {
        draft.count = 99;
      });
    });

    state.op.mutate((draft) => {
      draft.count = 1;
    });

    expect(emissions).toHaveLength(2);
    expect(emissions[0]?.ops).toEqual([
      { do: { op: "replace", path: "/count", value: 1 }, undo: { op: "replace", path: "/count", value: 0 } },
    ]);
    expect(emissions[0]?.state).toEqual(expect.objectContaining({ count: 1 }));

    expect(emissions[1]?.ops).toEqual([
      { do: { op: "replace", path: "/count", value: 99 }, undo: { op: "replace", path: "/count", value: 1 } },
    ]);
    expect(emissions[1]?.state).toEqual(expect.objectContaining({ count: 99 }));
    expect(unwrap(state).count).toBe(99);
  });

  it("does not hear a standalone state", () => {
    const group = createGroup();
    const emissions = new Array<Emission>();

    group.subscribe((state, ops, options) => {
      emissions.push({ state, ops, options });
    });

    const standalone = createState<Counter>(defineCounter);
    const ownEmissions = new Array<Array<Op>>();

    standalone.op.subscribe((_state, ops) => {
      ownEmissions.push(ops);
    });

    standalone.op.mutate((draft) => {
      draft.count = 1;
    });

    expect(emissions).toHaveLength(0);
    expect(ownEmissions).toHaveLength(1);
  });

  it("isolates two groups", () => {
    const first = createGroup();
    const second = createGroup();
    const firstEmissions = new Array<Emission>();
    const secondEmissions = new Array<Emission>();

    first.subscribe((state, ops, options) => {
      firstEmissions.push({ state, ops, options });
    });
    second.subscribe((state, ops, options) => {
      secondEmissions.push({ state, ops, options });
    });

    const state = first.createState<Counter>(defineCounter);

    state.op.mutate((draft) => {
      draft.count = 1;
    });

    expect(firstEmissions).toHaveLength(1);
    expect(secondEmissions).toHaveLength(0);
  });

  it("stops calling a listener after its remover runs", () => {
    const group = createGroup();
    const emissions = new Array<Emission>();
    const remove = group.subscribe((state, ops, options) => {
      emissions.push({ state, ops, options });
    });
    const state = group.createState<Counter>(defineCounter);

    remove();
    state.op.mutate((draft) => {
      draft.count = 1;
    });

    expect(emissions).toHaveLength(0);
  });

  it("calls a group listener first whenever it subscribed, then state listeners in subscription order", () => {
    const group = createGroup();
    const order = new Array<string>();

    const state = group.createState<Counter>(defineCounter);

    state.op.subscribe(() => order.push("first"));
    group.subscribe(() => order.push("group"));
    state.op.subscribe(() => order.push("second"));

    state.op.mutate((draft) => {
      draft.count = 1;
    });

    expect(order).toEqual(["group", "first", "second"]);
  });
});
