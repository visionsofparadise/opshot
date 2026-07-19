import { snapshot } from "valtio/vanilla";

import { installBoundary } from "./boundary";
import { createState, type State } from "../createState";
import { type Op } from "../ops/operation";
import { ignore } from "../ignore";

const recordEmissions = <T extends object>(state: State<T>): Array<{ state: State<T>; ops: Array<Op> }> => {
  const emissions = new Array<{ state: State<T>; ops: Array<Op> }>();

  state.op.subscribe((emittedState, ops) => {
    emissions.push({ state: emittedState, ops });
  });

  return emissions;
};

describe("boundary: tracked lane", () => {
  it("tracks nested plain objects and arrays with fine-grained ops", () => {
    const state = createState({ document: { title: "a", tags: ["x", "y"] } });
    const emissions = recordEmissions(state);

    state.mutate((mutable) => {
      mutable.document.title = "b";
    });

    state.mutate((mutable) => {
      mutable.document.tags[1] = "z";
    });

    expect(emissions.map((emission) => emission.ops)).toEqual([
      [{ isPatch: true, do: { op: "replace", path: "/document/title", value: "b" }, undo: { op: "replace", path: "/document/title", value: "a" } }],
      [{ isPatch: true, do: { op: "replace", path: "/document/tags/1", value: "z" }, undo: { op: "replace", path: "/document/tags/1", value: "y" } }],
    ]);
  });

  it("tracks an iterable plain object with fine-grained ops", () => {
    // Valtio's default predicate excluded any Symbol.iterator carrier, so this child was silently
    // untracked (writes landed raw, no emission). The boundary's plain-prototype test closes the hole.
    const state = createState({
      collection: {
        count: 0,
        [Symbol.iterator]: function* () {
          yield 1;
        },
      },
    });
    const emissions = recordEmissions(state);

    state.mutate((mutable) => {
      mutable.collection.count = 1;
    });

    expect(emissions).toHaveLength(1);
    expect(emissions[0]?.ops).toEqual([
      { isPatch: true, do: { op: "replace", path: "/collection/count", value: 1 }, undo: { op: "replace", path: "/collection/count", value: 0 } },
    ]);
    expect(state.op.unwrap().collection.count).toBe(1);
  });
});

describe("boundary: throws at entry", () => {
  it("throws for a Map in the define literal, naming TrackedMap and ignore", () => {
    expect(() => createState({ lookup: new Map<string, number>() })).toThrow(
      "opshot: Map cannot be tracked (its state lives in internal slots). Options: use TrackedMap for a tracked equivalent; ignore(value) to store it by reference, untracked.",
    );
  });

  it("throws for a Set, naming TrackedSet and ignore", () => {
    expect(() => createState({ members: new Set<string>() })).toThrow(
      "opshot: Set cannot be tracked (its state lives in internal slots). Options: use TrackedSet for a tracked equivalent; ignore(value) to store it by reference, untracked.",
    );
  });

  it("throws for a Date, naming TrackedDate and ignore", () => {
    expect(() => createState({ createdAt: new Date() })).toThrow(
      "opshot: Date cannot be tracked (its state lives in internal slots). Options: use TrackedDate for a tracked equivalent; ignore(value) to store it by reference, untracked.",
    );
  });

  it("throws for an offending value nested inside the define literal", () => {
    expect(() => createState({ outer: { m: new Map<string, number>() } })).toThrow("opshot: Map cannot be tracked");
  });

  it("throws at the assigning line inside mutate, leaving the state unchanged", () => {
    interface Box {
      box: unknown;
    }

    const state = createState<Box>(() => ({ box: null }));

    expect(() => {
      state.mutate((mutable) => {
        mutable.box = new Map<string, number>();
      });
    }).toThrow("opshot: Map cannot be tracked");

    expect(state.op.unwrap().box).toBe(null);
  });

  it("throws for a private-field class, naming its hidden state", () => {
    class Vault {
      #combination = 7;

      read() {
        return this.#combination;
      }
    }

    expect(() => createState({ vault: new Vault() })).toThrow(
      "opshot: Vault cannot be tracked (its state is hidden in private fields). Options: ignore(value) to store it by reference, untracked.",
    );
  });

  it("throws for a Map subclass with the native-slot message under its own name", () => {
    class Cache extends Map<string, number> {}

    expect(() => createState({ cache: new Cache() })).toThrow(
      "opshot: Cache cannot be tracked (its state is hidden in internal slots). Options: ignore(value) to store it by reference, untracked.",
    );
  });

  it("throws for an array subclass instead of silently demoting it", () => {
    class Stack extends Array<number> {}

    expect(() => createState({ stack: new Stack() })).toThrow(
      "opshot: Stack cannot be tracked (array subclasses lose their prototype in snapshots). Options: ignore(value) to store it by reference, untracked.",
    );
  });

  it("throws for a clean class, naming ignore", () => {
    class Emitter {
      count = 0;
    }

    expect(() => createState({ emitter: new Emitter() })).toThrow(
      "opshot: Emitter cannot be tracked (class instances cannot be tracked). Options: ignore(value) to store it by reference, untracked.",
    );
  });

  it("throws for a frozen Map: freezing does not freeze internal slots", () => {
    expect(() => createState({ lookup: Object.freeze(new Map<string, number>()) })).toThrow("opshot: Map cannot be tracked");
  });
});

describe("boundary: admitted by rule", () => {
  it("auto-ignores a frozen plain object: same reference through snapshots, no ops, interior write throws", () => {
    const frozen = Object.freeze({ value: 1 });
    const state = createState({ box: frozen, tick: 0 });
    const emissions = recordEmissions(state);

    expect(state.op.unwrap().box).toBe(frozen);

    state.mutate((mutable) => {
      mutable.tick = 1;
    });

    expect(emissions).toHaveLength(1);
    expect(emissions[0]?.ops).toEqual([{ isPatch: true, do: { op: "replace", path: "/tick", value: 1 }, undo: { op: "replace", path: "/tick", value: 0 } }]);
    expect(state.op.unwrap().box).toBe(frozen);

    expect(() => {
      state.mutate((mutable) => {
        (mutable.box as { value: number }).value = 2;
      });
    }).toThrow(TypeError);
  });

  it("carries a symbol-keyed prop into snapshots, bumping the version without emission on write", () => {
    const marker: unique symbol = Symbol("marker");

    interface Flagged {
      count: number;
      [marker]: string;
    }

    const state = createState<Flagged>(() => ({ count: 0, [marker]: "initial" }));
    const emissions = recordEmissions(state);

    expect(state[marker]).toBe("initial");

    state.mutate((mutable) => {
      mutable[marker] = "written";
    });

    expect(emissions).toHaveLength(0);
    expect(state.op.unwrap()[marker]).toBe("written");
  });

  it("carries a non-enumerable prop into snapshots, absent from ops, bumping the version without emission on write", () => {
    interface Counted {
      count: number;
      hidden?: number;
    }

    const literal: Counted = { count: 0 };

    Object.defineProperty(literal, "hidden", { value: 0, writable: true, enumerable: false, configurable: true });

    const state = createState<Counted>(() => literal);
    const emissions = recordEmissions(state);

    expect(Object.getOwnPropertyDescriptor(state, "hidden")).toMatchObject({ value: 0, enumerable: false });

    state.mutate((mutable) => {
      mutable.hidden = 5;
    });

    expect(emissions).toHaveLength(0);

    state.mutate((mutable) => {
      mutable.count = 1;
    });

    expect(emissions).toHaveLength(1);
    expect(emissions[0]?.ops).toEqual([{ isPatch: true, do: { op: "replace", path: "/count", value: 1 }, undo: { op: "replace", path: "/count", value: 0 } }]);

    const emitted = emissions[0]?.state;

    if (!emitted) throw new Error("the state heard no emission");

    expect(Object.getOwnPropertyDescriptor(emitted, "hidden")).toMatchObject({ value: 5, enumerable: false });
  });

  it("keeps functions as identity leaves", () => {
    const first = (): string => "a";
    const second = (): string => "b";

    const state = createState({ run: first });
    const emissions = recordEmissions(state);

    state.mutate((mutable) => {
      mutable.run = second;
    });

    expect(emissions).toHaveLength(1);
    expect(emissions[0]?.ops).toEqual([{ isPatch: true, do: { op: "replace", path: "/run", value: second }, undo: { op: "replace", path: "/run", value: first } }]);
    expect(state.op.unwrap().run).toBe(second);
  });
});

describe("boundary: ignore lane", () => {
  it("admits an ignored Map by reference, untracked and silent", () => {
    const lookup = ignore(new Map<string, number>());
    const state = createState({ lookup, tick: 0 });
    const emissions = recordEmissions(state);

    expect(state.op.unwrap().lookup).toBe(lookup);

    state.mutate((mutable) => {
      mutable.lookup.set("hits", 1);
    });

    expect(emissions).toHaveLength(0);
    expect(lookup.get("hits")).toBe(1);
  });

  it("admits an ignored value at the assigning line", () => {
    interface Box {
      box: Map<string, number> | null;
    }

    const state = createState<Box>(() => ({ box: null }));
    const emissions = recordEmissions(state);
    const kept = ignore(new Map([["k", 1]]));

    state.mutate((mutable) => {
      mutable.box = kept;
    });

    expect(emissions).toHaveLength(1);
    expect(state.op.unwrap().box).toBe(kept);
  });
});

describe("boundary: accessor preservation", () => {
  interface Temperature {
    celsius: number;
    readonly fahrenheit: number;
    other: { n: number };
  }

  const createTemperature = (): State<Temperature> =>
    createState<Temperature>({
      celsius: 0,
      other: { n: 1 },
      get fahrenheit() {
        return (this.celsius * 9) / 5 + 32;
      },
    });

  it("keeps an own getter live on state generations, recomputing per generation", () => {
    const state = createTemperature();
    const emissions = recordEmissions(state);

    expect(state.fahrenheit).toBe(32);
    expect(Object.getOwnPropertyDescriptor(state, "fahrenheit")?.get).toBeTypeOf("function");

    state.mutate((mutable) => {
      mutable.celsius = 20;
    });

    const second = emissions[0]?.state;

    if (!second) throw new Error("the subscriber heard no emission");

    expect(second.fahrenheit).toBe(68);
    expect(Object.getOwnPropertyDescriptor(second, "fahrenheit")?.get).toBeTypeOf("function");
    expect(state.fahrenheit).toBe(32);
  });

  it("preserves snapshot cache identity and untouched-subtree structural sharing", () => {
    const state = createTemperature();
    const emissions = recordEmissions(state);

    const first = snapshot(state.op.unsafeMutable);

    expect(snapshot(state.op.unsafeMutable)).toBe(first);

    state.mutate((mutable) => {
      mutable.celsius = 20;
    });

    const second = emissions[0]?.state;

    if (!second) throw new Error("the subscriber heard no emission");

    expect(second).not.toBe(first);
    expect(second.other).toBe(state.other);
  });
});

describe("boundary: meta-mutation trap gates", () => {
  it("throws when a consumer calls Object.defineProperty on tracked state", () => {
    const state = createState({ count: 0 });

    expect(() => Object.defineProperty(state.op.unsafeMutable, "extra", { value: 1 })).toThrow(
      "opshot: defineProperty is not supported on tracked state; define properties in the createState literal",
    );
  });

  it("throws when a consumer calls Object.setPrototypeOf on tracked state", () => {
    const state = createState({ count: 0 });

    expect(() => Object.setPrototypeOf(state.op.unsafeMutable, null)).toThrow("opshot: setPrototypeOf is not supported on tracked state");
  });

  it("leaves ordinary set, delete, and nested writes through mutate unaffected", () => {
    interface Nested {
      count: number;
      hidden?: number;
      child: { value: number };
    }

    const state = createState<Nested>(() => ({ count: 0, hidden: 1, child: { value: 1 } }));
    const emissions = recordEmissions(state);

    state.mutate((mutable) => {
      mutable.count = 1;
      mutable.child.value = 9;
      mutable.child = { value: 20 };
      delete mutable.hidden;
    });

    expect(state.op.unwrap().count).toBe(1);
    expect(state.op.unwrap().child.value).toBe(20);
    expect(state.op.unwrap().hidden).toBeUndefined();
    expect(emissions).toHaveLength(1);
  });
});

describe("boundary: install", () => {
  it("installs idempotently", () => {
    installBoundary();
    installBoundary();

    const state = createState({ count: 0 });

    state.mutate((mutable) => {
      mutable.count = 1;
    });

    expect(state.op.unwrap().count).toBe(1);
    expect(() => createState({ lookup: new Map<string, number>() })).toThrow("opshot: Map cannot be tracked");
  });
});
