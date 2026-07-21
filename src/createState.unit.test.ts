import { createGroup } from "./createGroup";
import { createMeta } from "./createMeta";
import { augmentSideEffectCycleError, createState, type Emission, type OpshotHandle, type State } from "./createState";
import { isSameIdentity } from "./identity";
import { isState } from "./isState";
import { diffSnapshots } from "./ops/diff";
import { type Op } from "./ops/operation";
import { cyclicError } from "./ops/cloneValue";
import { ignore } from "./ignore";

vi.mock(import("./ops/diff"), { spy: true });

// The package carries no @types/node; this declares just the process surface the rejection capture uses.
declare const process: {
  listeners: (event: "unhandledRejection") => Array<(reason: unknown) => void>;
  on: (event: "unhandledRejection", listener: (reason: unknown) => void) => void;
  removeListener: (event: "unhandledRejection", listener: (reason: unknown) => void) => void;
  removeAllListeners: (event: "unhandledRejection") => void;
};

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

const recordEmissions = (state: State<object>): Array<{ ops: Array<Op>; meta: Record<string, unknown> }> => {
  const emissions = new Array<{ ops: Array<Op>; meta: Record<string, unknown> }>();

  state.op.subscribe((_state, ops, emission) => {
    if (!emission.isSideEffect) emissions.push({ ops, meta: emission.meta });
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
          mutate((mutable) => {
            mutable.count += 1;
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
        mutate((mutable) => {
          mutable.count = 1;
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

    expect(state).not.toBe(state.op.unsafeMutable);
  });

  it("keeps op and mutate non-enumerable while data and domain methods spread normally", () => {
    const state = createCounter();

    expect(Object.keys(state)).toEqual(["count", "increment"]);
    expect({ ...state }).toEqual({ count: 0, increment: state.increment });
    expect(JSON.stringify(state)).toBe('{"count":0}');
    expect(Object.getOwnPropertyDescriptor(state, "op")?.enumerable).toBe(false);
    expect(Object.getOwnPropertyDescriptor(state, "mutate")?.enumerable).toBe(false);
    expect(state.op.subscribe).toBeTypeOf("function");
    expect(state.mutate).toBeTypeOf("function");
  });

  it("throws on an assignment to a returned state, and emits nothing", () => {
    const state = createCounter();
    const emissions = recordEmissions(state);

    expect(() => {
      (state as Counter).count = 9;
    }).toThrow(TypeError);

    expect(emissions).toHaveLength(0);
    expect(state.op.unwrap().count).toBe(0);
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

    expect(state.op.unwrap().count).toBe(1);
  });

  it("leaves a held generation stale while unwrap returns current values", () => {
    const state = createCounter();

    state.increment();

    expect(state.count).toBe(0);
    expect(state.op.unwrap().count).toBe(1);
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
        mutate((mutable) => {
          mutable.count += 1;
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

    second.mutate((mutable) => {
      mutable.count = 5;
    });

    expect(first.op.unwrap().doubled).toBe(10);
    expect(first.doubled).toBe(0);
    expect(first.op.unwrap().count).toBe(5);
  });

  it("answers isSameIdentity across generations in both directions, and false for another state", () => {
    const { state, emissions } = createTrackedCounter();

    state.increment();

    const current = emissions[0];
    const other = createCounter();

    if (!current) throw new Error("the group heard no emission");

    expect(current).not.toBe(state);
    expect(isSameIdentity(state, current)).toBe(true);
    expect(isSameIdentity(current, state)).toBe(true);
    expect(isSameIdentity(state, state)).toBe(true);

    expect(isSameIdentity(state, other)).toBe(false);
    expect(isSameIdentity(other, state)).toBe(false);
    expect(isSameIdentity(state, { count: 0 })).toBe(false);
  });

  it("emits once per mutate with the caller's meta verbatim", () => {
    const state = createCounter();
    const emissions = recordEmissions(state);

    state.mutate((mutable) => {
      mutable.count = 1;
    }, { transactionKey: "drag", replay: true });

    expect(emissions).toHaveLength(1);
    expect(emissions[0]?.ops).toEqual([
      { isPatch: true, do: { op: "replace", path: ["count"], value: 1 }, undo: { op: "replace", path: ["count"], value: 0 } },
    ]);
    expect(emissions[0]?.meta).toEqual({ transactionKey: "drag", replay: true });

    state.mutate((mutable) => {
      mutable.count = 2;
    });

    expect(emissions).toHaveLength(2);
    expect(emissions[1]?.meta).toEqual({});
  });

  it("merges defaults under the caller's meta for a defaulted token, caller winning", () => {
    const token = createMeta<{ replay: boolean; transactionKey?: string }>({ replay: false });
    const state = createState({ count: 0 }, token);
    const heard = new Array<{ replay: boolean; transactionKey?: string }>();

    state.op.subscribe((_state, _ops, emission) => {
      if (!emission.isSideEffect) heard.push(emission.meta);
    });

    state.mutate((mutable) => {
      mutable.count = 1;
    }, {});

    state.mutate((mutable) => {
      mutable.count = 2;
    }, { replay: true, transactionKey: "drag" });

    expect(heard).toEqual([{ replay: false }, { replay: true, transactionKey: "drag" }]);
  });

  it("delivers exactly the caller's meta through a bare token, and requires it for required fields", () => {
    const token = createMeta<{ actor: string }>();
    const state = createState({ count: 0 }, token);
    const heard = new Array<{ actor: string }>();

    state.op.subscribe((_state, _ops, emission) => {
      if (!emission.isSideEffect) heard.push(emission.meta);
    });

    state.mutate((mutable) => {
      mutable.count = 1;
    }, { actor: "matt" });

    // @ts-expect-error a required meta field makes the meta argument required
    state.mutate((mutable) => {
      mutable.count = 2;
    });

    expect(heard).toEqual([{ actor: "matt" }, {}]);
  });

  it("skips the diff and the merge while nothing listens on a token state", () => {
    const token = createMeta<{ replay: boolean }>({ replay: false });
    const state = createState({ count: 0 }, token);

    vi.mocked(diffSnapshots).mockClear();

    state.mutate((mutable) => {
      mutable.count = 1;
    });

    expect(diffSnapshots).not.toHaveBeenCalled();
    expect(state.op.unwrap().count).toBe(1);
  });

  it("emits no ops for a getter, which snapshots keep live", () => {
    const state = createState<DerivedCounter>((mutate) => ({
      count: 0,
      get doubled() {
        return this.count * 2;
      },
      increment: () => {
        mutate((mutable) => {
          mutable.count += 1;
        });
      },
    }));
    const emissions = recordEmissions(state);
    const generations = new Array<State<DerivedCounter>>();

    state.op.subscribe((emitted) => {
      generations.push(emitted);
    });

    state.increment();

    expect(emissions[0]?.ops).toEqual([
      { isPatch: true, do: { op: "replace", path: ["count"], value: 1 }, undo: { op: "replace", path: ["count"], value: 0 } },
    ]);

    const second = generations[0];

    if (!second) throw new Error("the subscriber heard no emission");

    expect(Object.getOwnPropertyDescriptor(second, "doubled")?.get).toBeTypeOf("function");
    expect(second.doubled).toBe(2);
    expect(state.doubled).toBe(0);
  });

  it("emits nothing for an empty mutation", () => {
    const state = createCounter();
    const emissions = recordEmissions(state);

    state.mutate(() => undefined);
    state.mutate((mutable) => {
      mutable.count = 0;
    });

    expect(emissions).toHaveLength(0);
  });

  it("emits nothing when a mutation returns a field to its starting value", () => {
    const state = createCounter();
    const emissions = recordEmissions(state);

    state.mutate((mutable) => {
      mutable.count = 1;
      mutable.count = 0;
    });

    expect(emissions).toHaveLength(0);
  });

  it("throws on a nested mutate of the same state", () => {
    const state = createCounter();

    expect(() =>
      state.mutate((mutable) => {
        mutable.count = 1;

        state.mutate((inner) => {
          inner.count = 2;
        });
      }),
    ).toThrow("opshot: nested mutate on the same state");
  });

  it("clears the mutating flag when a callback throws", () => {
    const state = createCounter();

    expect(() =>
      state.mutate(() => {
        throw new Error("boom");
      }),
    ).toThrow("boom");

    expect(state.op.isMutating).toBe(false);

    state.increment();

    expect(state.op.unwrap().count).toBe(1);
  });

  it("lets a mutate of a second state run inside a callback and emit independently", () => {
    const first = createCounter();
    const second = createCounter();
    const firstEmissions = recordEmissions(first);
    const secondEmissions = recordEmissions(second);

    first.mutate((mutable) => {
      mutable.count = 1;

      second.mutate((other) => {
        other.count = 7;
      });
    });

    expect(firstEmissions).toHaveLength(1);
    expect(secondEmissions).toHaveLength(1);
    expect(secondEmissions[0]?.ops).toEqual([
      { isPatch: true, do: { op: "replace", path: ["count"], value: 7 }, undo: { op: "replace", path: ["count"], value: 0 } },
    ]);
    expect(second.op.unwrap().count).toBe(7);
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

    expect(state.op.unwrap().count).toBe(2);
  });

  it("carries an ignore() field through without producing ops for its internals", () => {
    interface Log {
      index: number;
      readonly entries: Array<string>;
      append: (entry: string) => void;
    }

    const state = createState<Log>((mutate) => ({
      index: 0,
      entries: ignore(new Array<string>()),
      append: (entry) => {
        mutate((mutable) => {
          mutable.entries.push(entry);
          mutable.index += 1;
        });
      },
    }));
    const emissions = recordEmissions(state);

    state.append("one");

    expect(state.op.unwrap().entries).toEqual(["one"]);
    expect(emissions).toHaveLength(1);
    expect(emissions[0]?.ops).toEqual([
      { isPatch: true, do: { op: "replace", path: ["index"], value: 1 }, undo: { op: "replace", path: ["index"], value: 0 } },
    ]);
  });

  it("keeps a retained define literal out of the state", () => {
    const literal: Counter = { count: 0, increment: () => {} };
    const state = createState<Counter>(() => literal);
    const emissions = recordEmissions(state);

    literal.count = 9;

    expect((state.op.unsafeMutable as Counter).count).toBe(0);
    expect(Object.hasOwn(literal, "op")).toBe(false);
    expect(state.op.unwrap().count).toBe(0);
    expect(emissions).toHaveLength(0);
  });

  it("accepts the same literal object twice and yields independent states", () => {
    const defaults = { count: 0 };

    const first = createState<{ count: number }>(() => defaults);
    const second = createState<{ count: number }>(() => defaults);

    expect(isSameIdentity(first, second)).toBe(false);

    first.mutate((mutable) => {
      mutable.count = 5;
    });

    expect(first.op.unwrap().count).toBe(5);
    expect(second.op.unwrap().count).toBe(0);
    expect(defaults.count).toBe(0);
  });

  it("accepts a plain-object define and mutates like the callback form", () => {
    const state = createState({ count: 0 });
    const emissions = recordEmissions(state);

    state.mutate((mutable) => {
      mutable.count = 3;
    });

    expect(emissions).toHaveLength(1);
    expect(emissions[0]?.ops).toEqual([
      { isPatch: true, do: { op: "replace", path: ["count"], value: 3 }, undo: { op: "replace", path: ["count"], value: 0 } },
    ]);
    expect(state.op.unwrap().count).toBe(3);
    expect(state.count).toBe(0);
  });

  it("still drives a domain-method state through the callback form", () => {
    const state = createCounter();

    state.increment();
    state.increment();

    expect(state.op.unwrap().count).toBe(2);
  });

  it("accepts the same plain object twice and yields top-level-independent states", () => {
    const defaults = { count: 0 };

    const first = createState(defaults);
    const second = createState(defaults);

    expect(first.op).not.toBe(second.op);
    expect(isSameIdentity(first, second)).toBe(false);

    first.mutate((mutable) => {
      mutable.count = 5;
    });

    expect(first.op.unwrap().count).toBe(5);
    expect(second.op.unwrap().count).toBe(0);
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

  it("throws on a define literal carrying the reserved mutate key", () => {
    expect(() => createState({ mutate: 1 })).toThrow('opshot: "mutate" is a reserved key on a state');
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

  it("skips the diff while nothing listens, and resumes when a listener arrives", () => {
    const state = createState({ count: 0 });

    vi.mocked(diffSnapshots).mockClear();

    state.mutate((mutable) => {
      mutable.count = 1;
    });

    expect(diffSnapshots).not.toHaveBeenCalled();
    expect(state.op.unwrap().count).toBe(1);

    const heard = new Array<Array<Op>>();
    const unsubscribe = state.op.subscribe((_state, ops) => heard.push(ops));

    state.mutate((mutable) => {
      mutable.count = 2;
    });

    expect(diffSnapshots).toHaveBeenCalledTimes(1);
    expect(heard).toEqual([
      [{ isPatch: true, do: { op: "replace", path: ["count"], value: 2 }, undo: { op: "replace", path: ["count"], value: 1 } }],
    ]);

    unsubscribe();

    state.mutate((mutable) => {
      mutable.count = 3;
    });

    expect(diffSnapshots).toHaveBeenCalledTimes(1);
    expect(heard).toHaveLength(1);
    expect(state.op.unwrap().count).toBe(3);
  });

  it("attaches mutate flat on the state, identity-stable across generations, and not on the handle", () => {
    const { state, emissions } = createTrackedCounter();

    state.mutate((mutable) => {
      mutable.count = 5;
    });

    const current = emissions[0];

    if (!current) throw new Error("the group heard no emission");

    expect(emissions).toHaveLength(1);
    expect(current.mutate).toBe(state.mutate);
    expect("mutate" in state.op).toBe(false);
    expect(state.op.unwrap().count).toBe(5);
  });

});

describe("watchdog", () => {
  const recordAll = (state: State<object>): Array<{ ops: Array<Op>; emission: Emission }> => {
    const heard = new Array<{ ops: Array<Op>; emission: Emission }>();

    state.op.subscribe((_state, ops, emission) => {
      heard.push({ ops, emission });
    });

    return heard;
  };

  it("reports an unsafeMutable write as faithful side-effect ops on the microtask flush", async () => {
    const state = createState({ count: 0 });
    const heard = recordAll(state);

    (state.op.unsafeMutable as { count: number }).count = 5;

    expect(heard).toHaveLength(0);

    await Promise.resolve();

    expect(heard).toEqual([
      {
        ops: [{ isPatch: true, do: { op: "replace", path: ["count"], value: 5 }, undo: { op: "replace", path: ["count"], value: 0 } }],
        emission: { isSideEffect: true },
      },
    ]);
    expect(state.op.unwrap().count).toBe(5);
  });

  it("emits exactly once for an owned mutate, with no watchdog echo on the flush", async () => {
    const state = createState({ count: 0 });
    const heard = recordAll(state);

    state.mutate((mutable) => {
      mutable.count = 1;
    });

    expect(heard).toHaveLength(1);
    expect(heard[0]?.emission).toEqual({ isSideEffect: false, meta: {} });

    await Promise.resolve();

    expect(heard).toHaveLength(1);
  });

  it("reports only the unowned remainder when a mutate and an unsafeMutable write share a tick", async () => {
    const state = createState({ count: 0, flag: false });
    const heard = recordAll(state);

    state.mutate((mutable) => {
      mutable.count = 1;
    });
    (state.op.unsafeMutable as { flag: boolean }).flag = true;

    await Promise.resolve();

    expect(heard).toHaveLength(2);
    expect(heard[0]?.emission).toEqual({ isSideEffect: false, meta: {} });
    expect(heard[0]?.ops).toEqual([
      { isPatch: true, do: { op: "replace", path: ["count"], value: 1 }, undo: { op: "replace", path: ["count"], value: 0 } },
    ]);
    expect(heard[1]?.emission).toEqual({ isSideEffect: true });
    expect(heard[1]?.ops).toEqual([
      { isPatch: true, do: { op: "replace", path: ["flag"], value: true }, undo: { op: "replace", path: ["flag"], value: false } },
    ]);
  });

  it("pays no diff for a side-effect write while nothing listens, and never retro-reports it", async () => {
    const group = createGroup();
    const state = group.createState({ count: 0 });

    vi.mocked(diffSnapshots).mockClear();

    (state.op.unsafeMutable as { count: number }).count = 1;

    await Promise.resolve();

    expect(diffSnapshots).not.toHaveBeenCalled();
    expect(state.op.unwrap().count).toBe(1);

    const heard = new Array<{ ops: Array<Op>; emission: Emission }>();

    group.subscribe((_state, ops, emission) => {
      heard.push({ ops, emission });
    });

    (state.op.unsafeMutable as { count: number }).count = 2;

    await Promise.resolve();

    expect(heard).toEqual([
      {
        ops: [{ isPatch: true, do: { op: "replace", path: ["count"], value: 2 }, undo: { op: "replace", path: ["count"], value: 1 } }],
        emission: { isSideEffect: true },
      },
    ]);
  });

  it("disarms with the last unsubscribe and re-arms fresh on the next subscribe", async () => {
    const state = createState({ count: 0 });
    const heard = new Array<{ ops: Array<Op>; emission: Emission }>();
    const unsubscribe = state.op.subscribe((_state, ops, emission) => {
      heard.push({ ops, emission });
    });

    unsubscribe();

    vi.mocked(diffSnapshots).mockClear();

    (state.op.unsafeMutable as { count: number }).count = 1;

    await Promise.resolve();

    expect(diffSnapshots).not.toHaveBeenCalled();
    expect(heard).toHaveLength(0);

    state.op.subscribe((_state, ops, emission) => {
      heard.push({ ops, emission });
    });

    (state.op.unsafeMutable as { count: number }).count = 2;

    await Promise.resolve();

    expect(heard).toEqual([
      {
        ops: [{ isPatch: true, do: { op: "replace", path: ["count"], value: 2 }, undo: { op: "replace", path: ["count"], value: 1 } }],
        emission: { isSideEffect: true },
      },
    ]);
  });

  it("surfaces a side-effect cycle as an unhandled rejection carrying the augmented error", async () => {
    const state = createState<{ node: Record<string, unknown> }>(() => ({ node: {} }));

    state.op.subscribe(() => {});

    const mutableRoot = state.op.unsafeMutable as { node: Record<string, unknown> };

    const priorListeners = process.listeners("unhandledRejection");
    const captured = new Array<unknown>();
    const capture = (reason: unknown): void => {
      captured.push(reason);
    };

    process.removeAllListeners("unhandledRejection");
    process.on("unhandledRejection", capture);

    try {
      mutableRoot.node["self"] = mutableRoot.node;

      await new Promise((resolve) => setTimeout(resolve, 0));

      mutableRoot.node["value"] = 1;

      await new Promise((resolve) => setTimeout(resolve, 0));
    } finally {
      process.removeListener("unhandledRejection", capture);

      for (const listener of priorListeners) process.on("unhandledRejection", listener);
    }

    expect(captured).toHaveLength(1);
    expect(captured[0]).toBeInstanceOf(Error);
    expect((captured[0] as Error).message).toBe(
      "opshot: a side-effect write created a cyclic value at /node/self. Cycles cannot be tracked. This surfaced asynchronously because the write bypassed mutate (an unsafeMutable write, or a shared/entangled state). Use ignore() for back-linked structures, or ids.",
    );
  });
});

describe("augmentSideEffectCycleError", () => {
  it("rewraps the diff's typed cycle error, preserving its path", () => {
    const error = cyclicError(["node", "self"]);
    const augmented = augmentSideEffectCycleError(error);

		expect(error.path).toEqual(["node", "self"]);
    expect(augmented).toBeInstanceOf(Error);
    expect(augmented?.message).toBe(
      "opshot: a side-effect write created a cyclic value at /node/self. Cycles cannot be tracked. This surfaced asynchronously because the write bypassed mutate (an unsafeMutable write, or a shared/entangled state). Use ignore() for back-linked structures, or ids.",
    );
  });

  it("leaves every other error alone", () => {
    expect(augmentSideEffectCycleError(new Error("opshot: nested mutate on the same state"))).toBeUndefined();
    expect(augmentSideEffectCycleError("not an error")).toBeUndefined();
  });
});
