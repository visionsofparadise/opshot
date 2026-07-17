import { ref } from "valtio/vanilla";

import { createGroup } from "./createGroup";
import { createState, isState, type MutateOptions, type OpshotHandle, type State } from "./createState";
import { type Op } from "./diff";
import { unwrap } from "./unwrap";

interface Counter {
  count: number;
  increment: () => void;
}

interface DerivedCounter extends Counter {
  readonly doubled: number;
}

const createCounter = (): State<Counter> =>
  createState<Counter>((mutate) => ({
    count: 0,
    increment: () => {
      mutate((draft) => {
        draft.count += 1;
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
      mutate((draft) => {
        draft.count += 1;
      });
    },
  }));

  return { state, emissions };
};

const recordEmissions = (state: State<object>): Array<{ ops: Array<Op>; options: MutateOptions }> => {
  const emissions = new Array<{ ops: Array<Op>; options: MutateOptions }>();

  state.op.subscribe((_state, ops, options) => {
    emissions.push({ ops, options });
  });

  return emissions;
};

describe("createState", () => {
  it("gives define a mutate and get that work after creation", () => {
    let capturedGet: (() => State<Counter>) | undefined;

    const state = createState<Counter>((mutate, get) => {
      capturedGet = get;

      return {
        count: 1,
        increment: () => {
          mutate((draft) => {
            draft.count += 1;
          });
        },
      };
    });

    state.increment();

    expect(capturedGet?.().count).toBe(2);
  });

  it("throws when mutate or get is called during define", () => {
    expect(() =>
      createState<{ count: number }>((mutate) => {
        mutate((draft) => {
          draft.count = 1;
        });

        return { count: 0 };
      }),
    ).toThrow("opshot: called during createState definition");

    expect(() =>
      createState<{ count: number }>((_mutate, get) => {
        get();

        return { count: 0 };
      }),
    ).toThrow("opshot: called during createState definition");
  });

  it("returns a snapshot, not the proxy", () => {
    const state = createCounter();

    expect(state).not.toBe(state.op.proxy);
  });

  it("throws on an assignment to a returned state, and emits nothing", () => {
    const state = createCounter();
    const emissions = recordEmissions(state);

    expect(() => {
      (state as Counter).count = 9;
    }).toThrow(TypeError);

    expect(emissions).toHaveLength(0);
    expect(unwrap(state).count).toBe(0);
  });

  it("throws on an assignment to a later generation too", () => {
    const { state, emissions } = createTrackedCounter();

    state.increment();

    const current = emissions[0];

    if (!current) throw new Error("the group heard no emission");

    expect(current).toEqual(expect.objectContaining({ count: 1 }));
    expect(() => {
      Object.assign(current, { count: 9 });
    }).toThrow(TypeError);

    expect(unwrap(state).count).toBe(1);
  });

  it("leaves a held generation stale while unwrap returns current values", () => {
    const state = createCounter();

    state.increment();

    expect(state.count).toBe(0);
    expect(unwrap(state).count).toBe(1);
  });

  it("carries mutate, domain methods, and recomputed getters onto snapshot generations", () => {
    const group = createGroup();
    const emissions = new Array<State<object>>();

    group.subscribe((state) => {
      emissions.push(state);
    });

    const first = group.createState<DerivedCounter>((mutate) => ({
      count: 0,
      get doubled() {
        return this.count * 2;
      },
      increment: () => {
        mutate((draft) => {
          draft.count += 1;
        });
      },
    }));

    expect(first.doubled).toBe(0);
    expect(isState(first)).toBe(true);

    first.increment();

    const emitted = emissions[0];

    if (!emitted) throw new Error("the group heard no emission");

    const second = emitted as State<DerivedCounter>;

    expect(second).not.toBe(first);
    expect(second.doubled).toBe(2);

    second.op.mutate((draft) => {
      draft.count = 5;
    });

    expect(unwrap(first).doubled).toBe(10);
    expect(first.doubled).toBe(0);
    expect(unwrap(first).count).toBe(5);
  });

  it("answers isSameState across generations in both directions, and false for another state", () => {
    const { state, emissions } = createTrackedCounter();

    state.increment();

    const current = emissions[0];
    const other = createCounter();

    if (!current) throw new Error("the group heard no emission");

    expect(current).not.toBe(state);
    expect(state.op.isSameState(current)).toBe(true);
    expect(current.op.isSameState(state)).toBe(true);
    expect(state.op.isSameState(state)).toBe(true);

    expect(state.op.isSameState(other)).toBe(false);
    expect(other.op.isSameState(state)).toBe(false);
    expect(state.op.isSameState({ count: 0 })).toBe(false);
    expect(state.op.isSameState(undefined)).toBe(false);
  });

  it("emits once per mutate with the caller's options verbatim", () => {
    const state = createCounter();
    const emissions = recordEmissions(state);

    state.op.mutate((draft) => {
      draft.count = 1;
    }, { transactionKey: "drag", appliedOps: true });

    expect(emissions).toHaveLength(1);
    expect(emissions[0]?.ops).toEqual([
      { do: { op: "replace", path: "/count", value: 1 }, undo: { op: "replace", path: "/count", value: 0 } },
    ]);
    expect(emissions[0]?.options).toEqual({ transactionKey: "drag", appliedOps: true });

    state.op.mutate((draft) => {
      draft.count = 2;
    });

    expect(emissions).toHaveLength(2);
    expect(emissions[1]?.options).toEqual({});
  });

  it("emits ops for a getter, which snapshots carry as data", () => {
    const state = createState<DerivedCounter>((mutate) => ({
      count: 0,
      get doubled() {
        return this.count * 2;
      },
      increment: () => {
        mutate((draft) => {
          draft.count += 1;
        });
      },
    }));
    const emissions = recordEmissions(state);

    state.increment();

    expect(emissions[0]?.ops).toEqual([
      { do: { op: "replace", path: "/count", value: 1 }, undo: { op: "replace", path: "/count", value: 0 } },
      { do: { op: "replace", path: "/doubled", value: 2 }, undo: { op: "replace", path: "/doubled", value: 0 } },
    ]);
  });

  it("emits nothing for an empty mutation", () => {
    const state = createCounter();
    const emissions = recordEmissions(state);

    state.op.mutate(() => undefined);
    state.op.mutate((draft) => {
      draft.count = 0;
    });

    expect(emissions).toHaveLength(0);
  });

  it("emits nothing when a mutation returns a field to its starting value", () => {
    const state = createCounter();
    const emissions = recordEmissions(state);

    state.op.mutate((draft) => {
      draft.count = 1;
      draft.count = 0;
    });

    expect(emissions).toHaveLength(0);
  });

  it("throws on a nested mutate of the same state", () => {
    const state = createCounter();

    expect(() =>
      state.op.mutate((draft) => {
        draft.count = 1;

        state.op.mutate((inner) => {
          inner.count = 2;
        });
      }),
    ).toThrow("opshot: nested mutate on the same state");
  });

  it("clears the mutating flag when a callback throws", () => {
    const state = createCounter();

    expect(() =>
      state.op.mutate(() => {
        throw new Error("boom");
      }),
    ).toThrow("boom");

    expect(state.op.isMutating).toBe(false);

    state.increment();

    expect(unwrap(state).count).toBe(1);
  });

  it("lets a mutate of a second state run inside a callback and emit independently", () => {
    const first = createCounter();
    const second = createCounter();
    const firstEmissions = recordEmissions(first);
    const secondEmissions = recordEmissions(second);

    first.op.mutate((draft) => {
      draft.count = 1;

      second.op.mutate((other) => {
        other.count = 7;
      });
    });

    expect(firstEmissions).toHaveLength(1);
    expect(secondEmissions).toHaveLength(1);
    expect(secondEmissions[0]?.ops).toEqual([
      { do: { op: "replace", path: "/count", value: 7 }, undo: { op: "replace", path: "/count", value: 0 } },
    ]);
    expect(unwrap(second).count).toBe(7);
  });

  it("stops calling a listener after its remover runs", () => {
    const state = createCounter();
    const emissions = new Array<Array<Op>>();
    const remove = state.op.subscribe((_state, ops) => {
      emissions.push(ops);
    });

    remove();
    state.increment();

    expect(emissions).toHaveLength(0);
  });

  it("keeps a detached domain method working", () => {
    const state = createCounter();
    const increment = state.increment;

    increment();
    increment();

    expect(unwrap(state).count).toBe(2);
  });

  it("recognizes states and rejects other values", () => {
    expect(isState(createCounter())).toBe(true);
    expect(isState({ count: 1 })).toBe(false);
    expect(isState({ op: { proxy: 1 } })).toBe(false);
    expect(isState(null)).toBe(false);
    expect(isState(undefined)).toBe(false);
    expect(isState("state")).toBe(false);
  });

  it("rejects a foreign object shaped like a state, which the old duck-check accepted", () => {
    expect(isState({ op: { proxy: {} } })).toBe(false);
  });

  it("keeps isState true on the fresh generation a subscriber receives after a mutation", () => {
    const { state, emissions } = createTrackedCounter();

    state.increment();

    const current = emissions[0];

    if (!current) throw new Error("the group heard no emission");

    expect(current).not.toBe(state);
    expect(isState(current)).toBe(true);
  });

  it("carries a ref() field through without producing ops for its internals", () => {
    interface Log {
      index: number;
      readonly entries: Array<string>;
      append: (entry: string) => void;
    }

    const state = createState<Log>((mutate) => ({
      index: 0,
      entries: ref(new Array<string>()),
      append: (entry) => {
        mutate((draft) => {
          draft.entries.push(entry);
          draft.index += 1;
        });
      },
    }));
    const emissions = recordEmissions(state);

    state.append("one");

    expect(unwrap(state).entries).toEqual(["one"]);
    expect(emissions).toHaveLength(1);
    expect(emissions[0]?.ops).toEqual([
      { do: { op: "replace", path: "/index", value: 1 }, undo: { op: "replace", path: "/index", value: 0 } },
    ]);
  });

  it("keeps a retained define literal out of the state", () => {
    const literal: Counter = { count: 0, increment: () => {} };
    const state = createState<Counter>(() => literal);
    const emissions = recordEmissions(state);

    literal.count = 9;

    expect((state.op.proxy as Counter).count).toBe(0);
    expect(Object.hasOwn(literal, "op")).toBe(false);
    expect(unwrap(state).count).toBe(0);
    expect(emissions).toHaveLength(0);
  });

  it("accepts the same literal object twice and yields independent states", () => {
    const defaults = { count: 0 };

    const first = createState<{ count: number }>(() => defaults);
    const second = createState<{ count: number }>(() => defaults);

    expect(first.op.isSameState(second)).toBe(false);

    first.op.mutate((draft) => {
      draft.count = 5;
    });

    expect(unwrap(first).count).toBe(5);
    expect(unwrap(second).count).toBe(0);
    expect(defaults.count).toBe(0);
  });

  it("accepts a plain-object define and mutates like the callback form", () => {
    const state = createState({ count: 0 });
    const emissions = recordEmissions(state);

    state.op.mutate((draft) => {
      draft.count = 3;
    });

    expect(emissions).toHaveLength(1);
    expect(emissions[0]?.ops).toEqual([
      { do: { op: "replace", path: "/count", value: 3 }, undo: { op: "replace", path: "/count", value: 0 } },
    ]);
    expect(unwrap(state).count).toBe(3);
    expect(state.count).toBe(0);
  });

  it("still drives a domain-method state through the callback form", () => {
    const state = createCounter();

    state.increment();
    state.increment();

    expect(unwrap(state).count).toBe(2);
  });

  it("accepts the same plain object twice and yields top-level-independent states", () => {
    const defaults = { count: 0 };

    const first = createState(defaults);
    const second = createState(defaults);

    expect(first.op).not.toBe(second.op);
    expect(first.op.isSameState(second)).toBe(false);

    first.op.mutate((draft) => {
      draft.count = 5;
    });

    expect(unwrap(first).count).toBe(5);
    expect(unwrap(second).count).toBe(0);
    expect(defaults.count).toBe(0);
  });

  it("throws when the write path is reassigned instead of installing a second one", () => {
    const state = createCounter();

    expect(() => {
      (state as { op: unknown }).op = {};
    }).toThrow(TypeError);
  });

  it("throws on a define literal carrying the reserved op key", () => {
    expect(() => createState(() => ({ op: "anything" }))).toThrow('opshot: "op" is a reserved key on a state');
  });

  it("keeps op identical and Map-keyable across generations, distinct across states", () => {
    const { state, emissions } = createTrackedCounter();
    const other = createCounter();
    const stacks = new Map<OpshotHandle<object>, string>([[state.op, "counter"]]);

    state.increment();

    const current = emissions[0];

    if (!current) throw new Error("the group heard no emission");

    expect(current).not.toBe(state);
    expect(current.op).toBe(state.op);
    expect(other.op).not.toBe(state.op);
    expect(stacks.get(current.op)).toBe("counter");
    expect(stacks.get(other.op)).toBeUndefined();
  });
});
