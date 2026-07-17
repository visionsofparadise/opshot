import { ref } from "valtio/vanilla";

import { createGroup } from "./createGroup";
import { createState, type State } from "./createState";

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
      mutate((proxy) => {
        proxy.count += 1;
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
      mutate((proxy) => {
        proxy.count += 1;
      });
    },
  }));

  return { state, emissions };
};

describe("unwrap", () => {
  it("strips exactly the library keys and keeps data and domain methods", () => {
    const state = createCounter();
    const data = state.op.unwrap();

    expect(Object.keys(data)).toEqual(["count", "label", "increment"]);
    expect(data.count).toBe(0);
    expect(data.label).toBe("hits");
  });

  it("strips the library key from every generation", () => {
    const { state, emissions } = createTrackedCounter();

    state.increment();

    const emitted = emissions[0];

    if (!emitted) throw new Error("the group heard no emission");

    const later = emitted as State<Counter>;

    for (const generation of [state, later]) {
      const data: object = generation.op.unwrap();

      expect(Object.keys(data)).toEqual(["count", "label", "increment"]);
      expect("op" in data).toBe(false);
    }
  });

  it("returns current values from a state held since creation", () => {
    const state = createCounter();

    state.increment();
    state.increment();

    expect(state.count).toBe(0);
    expect(state.op.unwrap().count).toBe(2);
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

  it("keeps a domain method working through the unwrapped copy, detached", () => {
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
        mutate((proxy) => {
          proxy.count += 1;
        });
      },
    }));

    expect(state.op.unwrap().doubled).toBe(0);

    state.increment();

    expect(state.op.unwrap().doubled).toBe(2);
  });

  it("keeps a ref() field mutable through the unwrapped copy", () => {
    const entries = ref(new Array<string>());

    interface Log {
      index: number;
      entries: typeof entries;
    }

    const state = createState<Log>(() => ({ index: 0, entries }));

    state.op.unwrap().entries.push("one");

    expect(entries).toEqual(["one"]);
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
