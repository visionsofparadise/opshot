// @vitest-environment jsdom

import { act, render, renderHook, screen } from "@testing-library/react";
import { type FC } from "react";

import { createGroup } from "./createGroup";
import { type State } from "./createState";
import { type Op } from "./diff";
import { resnapshot, useCreateGroup, useCreateState } from "./react";

interface Counter {
  count: number;
  increment: () => void;
}

const counterDefine = (mutate: (callback: (proxy: Counter) => void) => void): Counter => ({
  count: 0,
  increment: () => {
    mutate((proxy) => {
      proxy.count += 1;
    });
  },
});

describe("useCreateState", () => {
  it("returns the same state instance across re-renders", () => {
    const { result, rerender } = renderHook(() => useCreateState<Counter>(counterDefine));

    const first = result.current;

    rerender();

    expect(result.current.op).toBe(first.op);
    expect(result.current.op.isSameState(first)).toBe(true);
  });

  it("creates a working standalone state from a plain-object define", () => {
    const { result } = renderHook(() => useCreateState<{ count: number }>({ count: 0 }));

    act(() => {
      result.current.op.mutate((proxy) => {
        proxy.count += 1;
      });
    });

    expect(result.current.op.unwrap().count).toBe(1);
  });

  it("makes the creating component reactive to the fields it reads", async () => {
    let held: State<Counter> | undefined;

    const CounterView: FC = () => {
      const counter = useCreateState<Counter>(counterDefine);

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

  it("does not re-render a creating component that reads no fields", async () => {
    const renders = { app: 0, button: 0 };

    let held: State<Counter> | undefined;

    const CounterButton = resnapshot<{ counter: State<Counter> }>(({ counter }) => {
      renders.button += 1;

      return <span data-testid="count">{counter.count}</span>;
    });

    const App: FC = () => {
      renders.app += 1;

      const counter = useCreateState<Counter>(counterDefine);

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

    const CounterButton = resnapshot<{ counter: State<Counter> }>(({ counter }) => {
      renders.button += 1;

      return <span data-testid="child">{counter.count}</span>;
    });

    const App: FC = () => {
      renders.app += 1;

      const counter = useCreateState<Counter>(counterDefine);

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

    const Child = resnapshot<{ pair: State<Pair> }>(({ pair }) => {
      renders.child += 1;

      return (
        <span data-testid="child">
          {pair.x},{pair.y}
        </span>
      );
    });

    const App: FC = () => {
      renders.app += 1;

      const pair = useCreateState<Pair>({ x: 0, y: 0 });

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
      held?.op.mutate((proxy) => {
        proxy.y += 1;
      });
    });

    expect(screen.getByTestId("child").textContent).toBe("0,1");
    expect(renders).toEqual({ app: 1, child: 2 });

    await act(async () => {
      held?.op.mutate((proxy) => {
        proxy.x += 1;
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

    const { result } = renderHook(() => useCreateState<Counter>(counterDefine, group));

    act(() => {
      result.current.increment();
    });

    expect(heard).toHaveLength(1);
    expect(result.current.op.unwrap().count).toBe(1);
  });
});

describe("useCreateGroup", () => {
  it("returns the same group instance across re-renders", () => {
    const { result, rerender } = renderHook(() => useCreateGroup());

    const first = result.current;

    rerender();

    expect(result.current).toBe(first);
  });
});
