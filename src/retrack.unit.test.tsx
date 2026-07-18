// @vitest-environment jsdom

import { act, render, screen } from "@testing-library/react";
import { applyPatch } from "fast-json-patch";
import { useState, type FC, type ReactNode } from "react";
import { subscribe as valtioSubscribe } from "valtio/vanilla";

import { createState, type State } from "./createState";
import { type Op } from "./diff";
import { retrack } from "./react";

vi.mock("valtio/vanilla", async (importOriginal) => {
  const actual = await importOriginal<typeof import("valtio/vanilla")>();

  return { ...actual, subscribe: vi.fn(actual.subscribe) };
});

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

interface Doc {
  title: string;
}

const createDoc = (title: string): State<Doc> => createState<Doc>(() => ({ title }));

interface Selection {
  nodeId: string;
}

const createSelection = (nodeId: string): State<Selection> => createState<Selection>(() => ({ nodeId }));

class Emitter {
  readonly handlers = new Array<() => void>();

  constructor(readonly state: State<Counter>) {}
}

const Inner: FC<{ state: State<Counter> }> = ({ state }) => <span>{state.count}</span>;

describe("retrack", () => {
  it("substitutes fresh snapshots for states anywhere in props", async () => {
    interface ProbeProps {
      counter: State<Counter>;
      context: { nested: State<Counter> };
      label: string;
    }

    const counter = createCounter();
    const nested = createCounter();

    let received: ProbeProps | undefined;

    const Probe = retrack<ProbeProps>((props) => {
      received = props;

      return (
        <span data-testid="values">
          {props.counter.count},{props.context.nested.count}
        </span>
      );
    });

    render(<Probe counter={counter} context={{ nested }} label="one" />);

    await act(async () => {
      counter.increment();
      nested.increment();
      nested.increment();
    });

    expect(screen.getByTestId("values").textContent).toBe("1,2");

    expect(received?.counter).not.toBe(counter);
    expect(received?.counter.count).toBe(1);
    expect(received?.counter.op.unsafeMutable).toBe(counter.op.unsafeMutable);
    expect(counter.count).toBe(0);

    expect(received?.context.nested).not.toBe(nested);
    expect(received?.context.nested.count).toBe(2);
    expect(received?.context.nested.op.unsafeMutable).toBe(nested.op.unsafeMutable);

    expect(received?.label).toBe("one");
  });

  it("does not rebuild the valtio subscription when re-rendering with unchanged states", () => {
    const counter = createCounter();

    const Child = retrack<{ counter: State<Counter>; tick: number }>(({ counter: snap, tick }) => (
      <span>{snap.count + tick}</span>
    ));

    let forceRerender: (() => void) | undefined;

    const Parent: FC = () => {
      const [tick, setTick] = useState(0);

      forceRerender = () => {
        setTick((value) => value + 1);
      };

      return <Child counter={counter} tick={tick} />;
    };

    vi.mocked(valtioSubscribe).mockClear();

    render(<Parent />);

    const initialCalls = vi.mocked(valtioSubscribe).mock.calls.length;

    expect(initialCalls).toBe(1);

    act(() => {
      forceRerender?.();
    });

    act(() => {
      forceRerender?.();
    });

    expect(screen.getByText("2")).toBeDefined();
    expect(vi.mocked(valtioSubscribe).mock.calls.length).toBe(initialCalls);
  });

  it("re-renders with the fresh snapshot when a state mutates outside React", async () => {
    const counter = createCounter();

    const Probe = retrack<{ counter: State<Counter> }>(({ counter: snap }) => (
      <span data-testid="count">{snap.count}</span>
    ));

    render(<Probe counter={counter} />);

    expect(screen.getByTestId("count").textContent).toBe("0");

    await act(async () => {
      counter.increment();
    });

    expect(screen.getByTestId("count").textContent).toBe("1");
  });

  it("skips re-render when props and its own states are unchanged", async () => {
    const first = createCounter();
    const second = createCounter();
    const renders: Record<string, number> = { first: 0, second: 0 };

    const Child = retrack<{ counter: State<Counter>; name: string }>(({ counter, name }) => {
      renders[name] = (renders[name] ?? 0) + 1;

      return <span>{counter.count}</span>;
    });

    let forceRerender: (() => void) | undefined;

    const Parent: FC = () => {
      const [, setTick] = useState(0);

      forceRerender = () => {
        setTick((tick) => tick + 1);
      };

      return (
        <>
          <Child counter={first} name="first" />
          <Child counter={second} name="second" />
        </>
      );
    };

    render(<Parent />);

    expect(renders).toEqual({ first: 1, second: 1 });

    act(() => {
      forceRerender?.();
    });

    expect(renders).toEqual({ first: 1, second: 1 });

    await act(async () => {
      second.increment();
    });

    expect(renders).toEqual({ first: 1, second: 2 });
  });

  it("re-renders on a replay", async () => {
    const counter = createCounter();
    const recorded: Array<Op> = [];

    counter.op.subscribe((_state, ops, meta) => {
      if (meta.replay !== true) recorded.push(...ops);
    });

    const Probe = retrack<{ counter: State<Counter> }>(({ counter: snap }) => (
      <span data-testid="count">{snap.count}</span>
    ));

    render(<Probe counter={counter} />);

    await act(async () => {
      counter.increment();
    });

    expect(screen.getByTestId("count").textContent).toBe("1");

    await act(async () => {
      counter.mutate((mutable) => {
        applyPatch(mutable, [...recorded].reverse().map((op) => op.undo));
      }, { replay: true });
    });

    expect(screen.getByTestId("count").textContent).toBe("0");
  });

  it("does not traverse class instances or children", () => {
    interface ProbeProps {
      context: { emitter: Emitter };
      children: ReactNode;
    }

    const counter = createCounter();
    const emitter = new Emitter(counter);
    const children = <Inner state={counter} />;

    let received: ProbeProps | undefined;

    const Probe = retrack<ProbeProps>((props) => {
      received = props;

      return null;
    });

    render(<Probe context={{ emitter }}>{children}</Probe>);

    expect(received?.context.emitter).toBe(emitter);
    expect(received?.context.emitter.state).toBe(counter);
    expect(received?.children).toBe(children);
  });

  it("resolves both states when one appears at a key that shifts another state's index", () => {
    const doc = createDoc("draft");
    const selection = createSelection("n1");

    const Panel = retrack<{ context: { doc?: State<Doc>; selection: State<Selection> } }>(({ context }) => (
      <span data-testid="panel">
        {context.doc?.title ?? "-"}/{context.selection.nodeId}
      </span>
    ));

    let openDoc: (() => void) | undefined;

    const Parent: FC = () => {
      const [isDocOpen, setIsDocOpen] = useState(false);

      openDoc = () => {
        setIsDocOpen(true);
      };

      return <Panel context={isDocOpen ? { doc, selection } : { selection }} />;
    };

    render(<Parent />);

    expect(screen.getByTestId("panel").textContent).toBe("-/n1");

    act(() => {
      openDoc?.();
    });

    expect(screen.getByTestId("panel").textContent).toBe("draft/n1");
  });

  it("resolves the remaining state when one is removed from a context object", () => {
    const doc = createDoc("draft");
    const selection = createSelection("n1");

    const Panel = retrack<{ context: { doc?: State<Doc>; selection: State<Selection> } }>(({ context }) => (
      <span data-testid="panel">
        {context.doc?.title ?? "-"}/{context.selection.nodeId}
      </span>
    ));

    let closeDoc: (() => void) | undefined;

    const Parent: FC = () => {
      const [isDocOpen, setIsDocOpen] = useState(true);

      closeDoc = () => {
        setIsDocOpen(false);
      };

      return <Panel context={isDocOpen ? { doc, selection } : { selection }} />;
    };

    render(<Parent />);

    expect(screen.getByTestId("panel").textContent).toBe("draft/n1");

    act(() => {
      closeDoc?.();
    });

    expect(screen.getByTestId("panel").textContent).toBe("-/n1");
  });

  it("substitutes each entry when an array prop of states grows", async () => {
    const first = createCounter();
    const second = createCounter();

    first.increment();

    const Row = retrack<{ list: Array<State<Counter>> }>(({ list }) => (
      <span data-testid="row">{list.map((counter) => counter.count).join(",")}</span>
    ));

    let appendSecond: (() => void) | undefined;

    const Parent: FC = () => {
      const [hasSecond, setHasSecond] = useState(false);

      appendSecond = () => {
        setHasSecond(true);
      };

      return <Row list={hasSecond ? [first, second] : [first]} />;
    };

    render(<Parent />);

    expect(screen.getByTestId("row").textContent).toBe("1");

    act(() => {
      appendSecond?.();
    });

    expect(screen.getByTestId("row").textContent).toBe("1,0");

    await act(async () => {
      second.increment();
    });

    expect(screen.getByTestId("row").textContent).toBe("1,1");
  });

  it("renders a component with no states in props", () => {
    const Probe = retrack<{ label: string }>(({ label }) => <span data-testid="label">{label}</span>);

    const { rerender } = render(<Probe label="one" />);

    expect(screen.getByTestId("label").textContent).toBe("one");

    rerender(<Probe label="two" />);

    expect(screen.getByTestId("label").textContent).toBe("two");
  });

  it("re-renders only the components whose read fields changed", async () => {
    const state = createState({ count: 0, label: "hits" });
    const renders = { count: 0, label: 0 };

    const CountView = retrack<{ state: State<{ count: number; label: string }> }>(({ state: snap }) => {
      renders.count += 1;

      return <span data-testid="count">{snap.count}</span>;
    });

    const LabelView = retrack<{ state: State<{ count: number; label: string }> }>(({ state: snap }) => {
      renders.label += 1;

      return <span data-testid="label">{snap.label}</span>;
    });

    render(
      <>
        <CountView state={state} />
        <LabelView state={state} />
      </>,
    );

    expect(renders).toEqual({ count: 1, label: 1 });

    await act(async () => {
      state.mutate((mutable) => {
        mutable.count += 1;
      });
    });

    expect(screen.getByTestId("count").textContent).toBe("1");
    expect(renders).toEqual({ count: 2, label: 1 });

    await act(async () => {
      state.mutate((mutable) => {
        mutable.label = "misses";
      });
    });

    expect(screen.getByTestId("label").textContent).toBe("misses");
    expect(renders).toEqual({ count: 2, label: 2 });
  });

  it("gates re-renders per nested field read", async () => {
    interface Pair {
      a: { value: number };
      b: { value: number };
    }

    const state = createState<Pair>(() => ({ a: { value: 1 }, b: { value: 2 } }));

    let renders = 0;

    const AView = retrack<{ state: State<Pair> }>(({ state: snap }) => {
      renders += 1;

      return <span data-testid="a">{snap.a.value}</span>;
    });

    render(<AView state={state} />);

    await act(async () => {
      state.mutate((mutable) => {
        mutable.b.value = 9;
      });
    });

    expect(renders).toBe(1);

    await act(async () => {
      state.mutate((mutable) => {
        mutable.a.value = 5;
      });
    });

    expect(screen.getByTestId("a").textContent).toBe("5");
    expect(renders).toBe(2);
  });

  it("renders current values for a field first read after a gated change", async () => {
    const state = createState({ count: 0, label: "hits" });

    const View = retrack<{ state: State<{ count: number; label: string }>; showLabel: boolean }>(
      ({ state: snap, showLabel }) => <span data-testid="view">{showLabel ? snap.label : String(snap.count)}</span>,
    );

    let showLabel: (() => void) | undefined;

    const Parent: FC = () => {
      const [isLabelShown, setIsLabelShown] = useState(false);

      showLabel = () => {
        setIsLabelShown(true);
      };

      return <View state={state} showLabel={isLabelShown} />;
    };

    render(<Parent />);

    expect(screen.getByTestId("view").textContent).toBe("0");

    await act(async () => {
      state.mutate((mutable) => {
        mutable.label = "misses";
      });
    });

    expect(screen.getByTestId("view").textContent).toBe("0");

    act(() => {
      showLabel?.();
    });

    expect(screen.getByTestId("view").textContent).toBe("misses");
  });
});
