import { snapshot } from "valtio/vanilla";

import { createGroup } from "./createGroup";
import { createState, type State } from "./createState";
import { isSameIdentity } from "./identity";
import { ignore } from "./ignore";

interface Counter {
  count: number;
  label: string;
  increment: () => void;
}

interface DerivedCounter extends Counter {
  readonly doubled: number;
}

const createCounter = (): State<Counter> =>
  createState<Counter>((mutate) => ({
    count: 0,
    label: "hits",
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
    label: "hits",
    increment: () => {
      mutate((mutable) => {
        mutable.count += 1;
      });
    },
  }));

  return { state, emissions };
};

describe("unwrap", () => {
  it("returns the cached snapshot with clean enumerable keys", () => {
    const state = createCounter();
    const data = state.op.unwrap();

    expect(data).toBe(snapshot(state.op.unsafeMutable));
    expect(Object.keys(data)).toEqual(["count", "label", "increment"]);
    expect(data.count).toBe(0);
    expect(data.label).toBe("hits");
  });

  it("keeps the library keys non-enumerable on every generation", () => {
    const { state, emissions } = createTrackedCounter();

    state.increment();

    const emitted = emissions[0];

    if (!emitted) throw new Error("the group heard no emission");

    const later = emitted as State<Counter>;

    for (const generation of [state, later]) {
      expect(Object.keys(generation)).toEqual(["count", "label", "increment"]);
      expect("op" in generation).toBe(true);
      expect("mutate" in generation).toBe(true);
      expect(Object.getOwnPropertyDescriptor(generation, "op")?.enumerable).toBe(false);
      expect(Object.getOwnPropertyDescriptor(generation, "mutate")?.enumerable).toBe(false);
    }
  });

  it("returns current values from a state held since creation", () => {
    const state = createCounter();

    state.increment();
    state.increment();

    expect(state.count).toBe(0);
    expect(state.op.unwrap().count).toBe(2);
  });

  it("returns the registered generation and rejects a top-level write", () => {
    const state = createCounter();

    state.increment();

    const unwrapped = state.op.unwrap();

    expect(isSameIdentity(unwrapped, state)).toBe(true);
    expect(unwrapped).toBe(snapshot(state.op.unsafeMutable));
    expect(() => Object.assign(unwrapped, { count: 9 })).toThrow(TypeError);
    expect(state.op.unwrap().count).toBe(1);
  });

  it("returns current values from a stale generation held from mid-history", () => {
    const { state, emissions } = createTrackedCounter();

    state.increment();

    const emitted = emissions[0];

    if (!emitted) throw new Error("the group heard no emission");

    const stale = emitted as State<Counter>;

    state.increment();
    state.increment();

    expect(stale.count).toBe(1);
    expect(stale.op.unwrap().count).toBe(3);
  });

  it("keeps a detached domain method working through the unwrapped snapshot", () => {
    const state = createCounter();

    state.increment();

    const increment = state.op.unwrap().increment;

    increment();

    expect(state.op.unwrap().count).toBe(2);
  });

  it("recomputes a getter on every unwrap", () => {
    const state = createState<DerivedCounter>((mutate) => ({
      count: 0,
      label: "hits",
      get doubled() {
        return this.count * 2;
      },
      increment: () => {
        mutate((mutable) => {
          mutable.count += 1;
        });
      },
    }));

    expect(state.op.unwrap().doubled).toBe(0);

    state.increment();

    expect(state.op.unwrap().doubled).toBe(2);
  });

  it("keeps own getters live on the unwrapped snapshot", () => {
    const state = createState<DerivedCounter>((mutate) => ({
      count: 0,
      label: "hits",
      get doubled() {
        return this.count * 2;
      },
      increment: () => {
        mutate((mutable) => {
          mutable.count += 1;
        });
      },
    }));

    state.increment();

    const data = state.op.unwrap();
    const descriptor = Object.getOwnPropertyDescriptor(data, "doubled");

    expect(descriptor?.get).toBeTypeOf("function");
    expect(descriptor?.value).toBeUndefined();
    expect(data.doubled).toBe(2);
    expect(Object.getOwnPropertyDescriptor(state, "doubled")?.get).toBeTypeOf("function");
  });

  it("carries an ignore() field by reference through the unwrapped copy, mutable via the held handle", () => {
    const entries = ignore(new Array<string>());

    interface Log {
      index: number;
      entries: Array<string>;
    }

    const state = createState<Log>(() => ({ index: 0, entries }));

    expect(state.op.unwrap().entries).toBe(entries);

    entries.push("one");

    expect(state.op.unwrap().entries).toEqual(["one"]);
  });

  it("round-trips a data-only state through JSON", () => {
    interface Settings {
      theme: string;
      levels: Array<number>;
    }

    const state = createState<Settings>(() => ({ theme: "dark", levels: [1, 2] }));

    expect(JSON.parse(JSON.stringify(state.op.unwrap()))).toEqual({ theme: "dark", levels: [1, 2] });
  });
});
