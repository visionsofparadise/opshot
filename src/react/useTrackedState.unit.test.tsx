// @vitest-environment jsdom

import { act, render, renderHook, screen } from "@testing-library/react";
import { type FC } from "react";

import { createMeta } from "../createMeta";
import { createGroup } from "../createGroup";
import { type State } from "../createState";
import { isSameIdentity } from "../identity";
import { type Op } from "../ops/operation";
import { TrackedMap } from "../tracked/trackedMap";
import { retrack } from "./retrack";
import { useTrackedState } from "./useTrackedState";

interface Counter {
  count: number;
  increment: () => void;
}

const counterInitializer = (mutate: (callback: (mutable: Counter) => void) => void): Counter => ({
  count: 0,
  increment: () => {
    mutate((mutable) => {
      mutable.count += 1;
    });
  },
});

describe("useTrackedState", () => {
  it("returns the same state instance across re-renders", () => {
    const { result, rerender } = renderHook(() => useTrackedState<Counter>(counterInitializer));

    const first = result.current;

    rerender();

    expect(result.current.op).toBe(first.op);
    expect(isSameIdentity(result.current, first)).toBe(true);
  });

  it("creates a working standalone state from a plain-object define", () => {
    const { result } = renderHook(() => useTrackedState<{ count: number }>({ count: 0 }));

    act(() => {
      result.current.mutate((mutable) => {
        mutable.count += 1;
      });
    });

    expect(result.current.op.unwrap().count).toBe(1);
  });

  it("makes the creating component reactive to the fields it reads", async () => {
    let held: State<Counter> | undefined;

    const CounterView: FC = () => {
      const counter = useTrackedState<Counter>(counterInitializer);

      held = counter;

      return <span data-testid="count">{counter.count}</span>;
    };

    render(<CounterView />);

    expect(screen.getByTestId("count").textContent).toBe("0");

    await act(async () => {
      held?.increment();
    });

    expect(screen.getByTestId("count").textContent).toBe("1");
  });

  it("tracks size, get, and iteration readers independently", async () => {
    interface CollectionState {
      map: TrackedMap<string, { label: string }>;
      unrelated: string;
    }

    const createCollection = (): CollectionState => ({ map: new TrackedMap([["a", { label: "one" }]]), unrelated: "steady" });
    const renders = { size: 0, get: 0, iteration: 0 };

    const size = renderHook(() => {
      const state = useTrackedState<CollectionState>(createCollection);

      renders.size += 1;

      return { state, value: state.map.size };
    });
    const get = renderHook(() => {
      const state = useTrackedState<CollectionState>(createCollection);

      renders.get += 1;

      return { state, value: state.map.get("a")?.label ?? "-" };
    });
    const iteration = renderHook(() => {
      const state = useTrackedState<CollectionState>(createCollection);

      renders.iteration += 1;

      return { state, value: [...state.map].map(([key, value]) => `${key}:${value.label}`).join(",") };
    });

    expect(size.result.current.value).toBe(1);
    expect(get.result.current.value).toBe("one");
    expect(iteration.result.current.value).toBe("a:one");
    expect(renders).toEqual({ size: 1, get: 1, iteration: 1 });

    await act(async () => {
      size.result.current.state.mutate((mutable) => {
        mutable.map.set("b", { label: "bee" });
      });
      get.result.current.state.mutate((mutable) => {
        mutable.map.set("b", { label: "bee" });
      });
      iteration.result.current.state.mutate((mutable) => {
        mutable.map.set("b", { label: "bee" });
      });
    });

    expect(size.result.current.value).toBe(2);
    expect(get.result.current.value).toBe("one");
    expect(iteration.result.current.value).toBe("a:one,b:bee");
    expect(renders).toEqual({ size: 2, get: 2, iteration: 2 });

    await act(async () => {
      for (const state of [size.result.current.state, get.result.current.state, iteration.result.current.state]) {
        state.mutate((mutable) => {
          const value = mutable.map.get("a");

          if (value !== undefined) value.label = "two";
        });
      }
    });

    expect(size.result.current.value).toBe(2);
    expect(get.result.current.value).toBe("two");
    expect(iteration.result.current.value).toBe("a:two,b:bee");
    expect(renders).toEqual({ size: 2, get: 3, iteration: 3 });

    await act(async () => {
      for (const state of [size.result.current.state, get.result.current.state, iteration.result.current.state]) {
        state.mutate((mutable) => {
          mutable.map.delete("a");
        });
      }
    });

    expect(size.result.current.value).toBe(1);
    expect(get.result.current.value).toBe("-");
    expect(iteration.result.current.value).toBe("b:bee");
    expect(renders).toEqual({ size: 3, get: 4, iteration: 4 });

    await act(async () => {
      for (const state of [size.result.current.state, get.result.current.state, iteration.result.current.state]) {
        state.mutate((mutable) => {
          mutable.map.clear();
        });
      }
    });

    expect(size.result.current.value).toBe(0);
    expect(get.result.current.value).toBe("-");
    expect(iteration.result.current.value).toBe("");
    expect(renders).toEqual({ size: 4, get: 5, iteration: 5 });
  });

  it("does not re-render an unrelated plain-field reader for map mutations", async () => {
    interface CollectionState {
      map: TrackedMap<string, { label: string }>;
      unrelated: string;
    }

    let held: State<CollectionState> | undefined;
    let renders = 0;

    const PlainView: FC = () => {
      const state = useTrackedState<CollectionState>({ map: new TrackedMap(), unrelated: "steady" });

      held = state;
      renders += 1;

      return <span data-testid="unrelated">{state.unrelated}</span>;
    };

    render(<PlainView />);

    await act(async () => {
      held?.mutate((mutable) => {
        mutable.map.set("a", { label: "one" });
      });
    });

    await act(async () => {
      held?.mutate((mutable) => {
        const value = mutable.map.get("a");

        if (value !== undefined) value.label = "two";
      });
    });

    await act(async () => {
      held?.mutate((mutable) => {
        mutable.map.delete("a");
      });
    });

    await act(async () => {
      held?.mutate((mutable) => {
        mutable.map.set("b", { label: "bee" });
      });
    });

    await act(async () => {
      held?.mutate((mutable) => {
        mutable.map.clear();
      });
    });

    expect(screen.getByTestId("unrelated").textContent).toBe("steady");
    expect(renders).toBe(1);
  });

  it("does not re-render a creating component that reads no fields", async () => {
    const renders = { app: 0, button: 0 };

    let held: State<Counter> | undefined;

    const CounterButton = retrack<{ counter: State<Counter> }>(({ counter }) => {
      renders.button += 1;

      return <span data-testid="count">{counter.count}</span>;
    });

    const App: FC = () => {
      renders.app += 1;

      const counter = useTrackedState<Counter>(counterInitializer);

      held = counter;

      return <CounterButton counter={counter} />;
    };

    render(<App />);

    expect(renders).toEqual({ app: 1, button: 1 });

    await act(async () => {
      held?.increment();
    });

    expect(screen.getByTestId("count").textContent).toBe("1");
    expect(renders).toEqual({ app: 1, button: 2 });
  });

  it("re-renders both the creating reader and a wrapped child reading the same field", async () => {
    const renders = { app: 0, button: 0 };

    let held: State<Counter> | undefined;

    const CounterButton = retrack<{ counter: State<Counter> }>(({ counter }) => {
      renders.button += 1;

      return <span data-testid="child">{counter.count}</span>;
    });

    const App: FC = () => {
      renders.app += 1;

      const counter = useTrackedState<Counter>(counterInitializer);

      held = counter;

      return (
        <>
          <span data-testid="parent">{counter.count}</span>
          <CounterButton counter={counter} />
        </>
      );
    };

    render(<App />);

    expect(renders).toEqual({ app: 1, button: 1 });

    await act(async () => {
      held?.increment();
    });

    expect(screen.getByTestId("parent").textContent).toBe("1");
    expect(screen.getByTestId("child").textContent).toBe("1");
    expect(renders).toEqual({ app: 2, button: 2 });
  });

  it("bounds a re-render to a wrapped child whose extra read changed", async () => {
    interface Pair {
      x: number;
      y: number;
    }

    const renders = { app: 0, child: 0 };

    let held: State<Pair> | undefined;

    const Child = retrack<{ pair: State<Pair> }>(({ pair }) => {
      renders.child += 1;

      return (
        <span data-testid="child">
          {pair.x},{pair.y}
        </span>
      );
    });

    const App: FC = () => {
      renders.app += 1;

      const pair = useTrackedState<Pair>({ x: 0, y: 0 });

      held = pair;

      return (
        <>
          <span data-testid="parent">{pair.x}</span>
          <Child pair={pair} />
        </>
      );
    };

    render(<App />);

    expect(renders).toEqual({ app: 1, child: 1 });

    await act(async () => {
      held?.mutate((mutable) => {
        mutable.y += 1;
      });
    });

    expect(screen.getByTestId("child").textContent).toBe("0,1");
    expect(renders).toEqual({ app: 1, child: 2 });

    await act(async () => {
      held?.mutate((mutable) => {
        mutable.x += 1;
      });
    });

    expect(screen.getByTestId("parent").textContent).toBe("1");
    expect(screen.getByTestId("child").textContent).toBe("1,1");
    expect(renders).toEqual({ app: 2, child: 3 });
  });

  it("creates through a group so group.subscribe hears its ops", () => {
    const group = createGroup();
    const heard: Array<Array<Op>> = [];

    group.subscribe((_state, ops) => {
      heard.push(ops);
    });

    const { result } = renderHook(() => useTrackedState(counterInitializer, group));

    act(() => {
      result.current.increment();
    });

    expect(heard).toHaveLength(1);
    expect(result.current.op.unwrap().count).toBe(1);
  });

  it("delivers merged meta from a state created with a token", () => {
    const token = createMeta<{ replay: boolean }>({ replay: false });
    const heard = new Array<{ replay: boolean }>();

    const { result } = renderHook(() => useTrackedState({ count: 0 }, token));

    result.current.op.subscribe((_state, _ops, emission) => {
      if (!emission.isSideEffect) heard.push(emission.meta);
    });

    act(() => {
      result.current.mutate((mutable) => {
        mutable.count += 1;
      });
    });

    expect(heard).toEqual([{ replay: false }]);
    expect(result.current.op.unwrap().count).toBe(1);
  });
});
