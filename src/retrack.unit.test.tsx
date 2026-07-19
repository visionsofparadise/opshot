// @vitest-environment jsdom

import { act, render, screen } from "@testing-library/react";
import { applyPatch } from "fast-json-patch";
import { useState, type FC, type ReactNode } from "react";
import { subscribe as valtioSubscribe } from "valtio/vanilla";

import { createState, isState, type State } from "./createState";
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

    counter.op.subscribe((_state, ops, emission) => {
      if (!emission.isSideEffect && emission.meta.replay !== true) recorded.push(...ops);
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

  it("substitutes a state found inside a Map prop", async () => {
    const counter = createCounter();
    const bag = new Map<string, State<Counter>>([["counter", counter]]);

    const View = retrack<{ bag: Map<string, State<Counter>> }>(({ bag: fresh }) => (
      <span data-testid="value">{fresh.get("counter")?.count}</span>
    ));

    render(<View bag={bag} />);

    expect(screen.getByTestId("value").textContent).toBe("0");

    await act(async () => {
      counter.increment();
    });

    expect(screen.getByTestId("value").textContent).toBe("1");
    expect(bag.get("counter")).toBe(counter);
  });

  it("substitutes a state found inside a class-instance prop, preserving the prototype", async () => {
    const counter = createCounter();
    const emitter = new Emitter(counter);

    let received: { emitter: Emitter } | undefined;

    const View = retrack<{ emitter: Emitter }>((props) => {
      received = props;

      return <span data-testid="value">{props.emitter.state.count}</span>;
    });

    render(<View emitter={emitter} />);

    await act(async () => {
      counter.increment();
    });

    expect(screen.getByTestId("value").textContent).toBe("1");
    expect(received?.emitter).not.toBe(emitter);
    expect(received?.emitter).toBeInstanceOf(Emitter);
    expect(received?.emitter.handlers).toBe(emitter.handlers);
    expect(emitter.state).toBe(counter);
  });

  it("finds a state under a children key in plain tree data", async () => {
    const counter = createCounter();
    const tree = { children: [{ state: counter }] };

    const View = retrack<{ tree: { children: Array<{ state: State<Counter> }> } }>(({ tree: fresh }) => (
      <span data-testid="value">{fresh.children[0]?.state.count}</span>
    ));

    render(<View tree={tree} />);

    expect(screen.getByTestId("value").textContent).toBe("0");

    await act(async () => {
      counter.increment();
    });

    expect(screen.getByTestId("value").textContent).toBe("1");
  });

  it("skips cycles and finds a state reachable through a cyclic prop", async () => {
    interface Cyclic {
      label: string;
      state: State<Counter>;
      self?: Cyclic;
    }

    const counter = createCounter();
    const cyclic: Cyclic = { label: "loop", state: counter };

    cyclic.self = cyclic;

    const View = retrack<{ data: Cyclic }>(({ data }) => <span data-testid="value">{data.state.count}</span>);

    expect(() => {
      render(<View data={cyclic} />);
    }).not.toThrow();

    expect(screen.getByTestId("value").textContent).toBe("0");

    await act(async () => {
      counter.increment();
    });

    expect(screen.getByTestId("value").textContent).toBe("1");
  });

  it("does not traverse React elements: a state planted behind $$typeof stays undiscovered", async () => {
    const counter = createCounter();
    const decoy = { $$typeof: Symbol.for("react.element"), state: counter };

    const View = retrack<{ decoy: typeof decoy }>(({ decoy: fresh }) => (
      <span data-testid="value">{fresh.state.count}</span>
    ));

    render(<View decoy={decoy} />);

    await act(async () => {
      counter.increment();
    });

    // Pinned as intended: $$typeof positively identifies a React element and the walk leaves it whole.
    expect(screen.getByTestId("value").textContent).toBe("0");
  });

  it("passes a React element child through untouched while substituting a sibling state", async () => {
    interface ProbeProps {
      counter: State<Counter>;
      children: ReactNode;
    }

    const counter = createCounter();
    const children = <Inner state={counter} />;

    let received: ProbeProps | undefined;

    const Probe = retrack<ProbeProps>((props) => {
      received = props;

      return null;
    });

    render(<Probe counter={counter}>{children}</Probe>);

    expect(received?.children).toBe(children);
    expect(received?.counter).not.toBe(counter);
  });

  it("does not descend a DOM element's __react-prefixed expando keys", async () => {
    // React stamps fiber references onto host DOM nodes as __reactFiber$-style expandos; the walk
    // skips those keys, since descending one would pull the application's entire fiber graph (and
    // any state reachable through it) into discovery. A state planted there stays stale.
    const counter = createCounter();
    const element = Object.assign(document.createElement("div"), { "__reactFiber$test": { state: counter } });

    const View = retrack<{ anchor: typeof element }>(({ anchor }) => (
      <span data-testid="value">{anchor["__reactFiber$test"].state.count}</span>
    ));

    vi.mocked(valtioSubscribe).mockClear();

    render(<View anchor={element} />);

    expect(vi.mocked(valtioSubscribe).mock.calls.length).toBe(0);

    await act(async () => {
      counter.increment();
    });

    expect(screen.getByTestId("value").textContent).toBe("0");
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

  it("gates a component reading only a derived getter on the data it derives from", async () => {
    interface Temperature {
      celsius: number;
      readonly fahrenheit: number;
      label: string;
    }

    const state = createState<Temperature>({
      celsius: 0,
      label: "outside",
      get fahrenheit() {
        return (this.celsius * 9) / 5 + 32;
      },
    });

    let renders = 0;

    const View = retrack<{ state: State<Temperature> }>(({ state: snap }) => {
      renders += 1;

      return <span data-testid="fahrenheit">{snap.fahrenheit}</span>;
    });

    render(<View state={state} />);

    expect(screen.getByTestId("fahrenheit").textContent).toBe("32");
    expect(renders).toBe(1);

    await act(async () => {
      state.mutate((mutable) => {
        mutable.label = "inside";
      });
    });

    expect(renders).toBe(1);

    await act(async () => {
      state.mutate((mutable) => {
        mutable.celsius = 20;
      });
    });

    expect(screen.getByTestId("fahrenheit").textContent).toBe("68");
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

  it("finds a state nested within the default depth and misses one nested deeper unless maxDepth is raised", async () => {
    // A state keyCount segments under props: the prop key plus keyCount - 1 object layers.
    const nestState = (state: State<Counter>, keyCount: number): Record<string, unknown> => {
      let value: unknown = state;

      for (let index = 0; index < keyCount - 1; index += 1) value = { a: value };

      return value as Record<string, unknown>;
    };

    const readLeafCount = (data: Record<string, unknown>): number => {
      let current: unknown = data;

      while (!isState(current)) current = (current as Record<string, unknown>)["a"];

      return (current as State<Counter>).count;
    };

    const DeepView: FC<{ data: Record<string, unknown>; name: string }> = ({ data, name }) => (
      <span data-testid={name}>{readLeafCount(data)}</span>
    );

    const AtLimit = retrack(DeepView);
    const PastLimit = retrack(DeepView);
    const Raised = retrack(DeepView, { maxDepth: 12 });

    const atLimit = createCounter();
    const pastLimit = createCounter();
    const raised = createCounter();

    render(
      <>
        <AtLimit data={nestState(atLimit, 10)} name="at-limit" />
        <PastLimit data={nestState(pastLimit, 11)} name="past-limit" />
        <Raised data={nestState(raised, 11)} name="raised" />
      </>,
    );

    await act(async () => {
      atLimit.increment();
      pastLimit.increment();
      raised.increment();
    });

    expect(screen.getByTestId("at-limit").textContent).toBe("1");
    expect(screen.getByTestId("past-limit").textContent).toBe("0");
    expect(screen.getByTestId("raised").textContent).toBe("1");
  });

  it("throws at render when a state sits inside a private-field class prop", () => {
    class SecretHolder {
      #hidden = "secret";

      constructor(readonly state: State<Counter>) {}

      reveal(): string {
        return this.#hidden;
      }
    }

    const holder = new SecretHolder(createCounter());

    const View = retrack<{ holder: SecretHolder }>(({ holder: fresh }) => <span>{fresh.state.count}</span>);

    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      expect(() => render(<View holder={holder} />)).toThrow(
        "opshot: retrack found a state inside SecretHolder, whose private fields can't survive substitution. Move the state to a plain container, or ignore() the SecretHolder.",
      );
    } finally {
      consoleError.mockRestore();
    }
  });

  it("throws at render when a state sits inside an array-subclass prop", () => {
    class Tagged extends Array<State<Counter>> {}

    const tagged = new Tagged();
    tagged.push(createCounter());

    const View = retrack<{ data: Tagged }>(({ data }) => <span>{data.length}</span>);

    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      expect(() => render(<View data={tagged} />)).toThrow(
        "opshot: retrack found a state inside Tagged, an array subclass whose prototype can't survive substitution. Move the state to a plain array, or ignore() the Tagged.",
      );
    } finally {
      consoleError.mockRestore();
    }
  });

  it("throws at render when a state sits behind an accessor on a class-instance prop", () => {
    class Panel {
      declare readonly state: State<Counter>;

      constructor(state: State<Counter>) {
        Object.defineProperty(this, "state", { get: () => state, enumerable: true, configurable: true });
      }
    }

    const panel = new Panel(createCounter());

    const View = retrack<{ panel: Panel }>(({ panel: fresh }) => <span>{fresh.state.count}</span>);

    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      expect(() => render(<View panel={panel} />)).toThrow(
        'opshot: retrack found a state behind the accessor "state" on Panel, which can\'t survive substitution. Move the state to a plain container, or ignore() the Panel.',
      );
    } finally {
      consoleError.mockRestore();
    }
  });

  it("renders a foreign private-bearing object with no state inside", () => {
    class QueryClient {
      #cache = new Map<string, unknown>();

      readonly config = { retries: 3 };

      size(): number {
        return this.#cache.size;
      }
    }

    const client = new QueryClient();
    const counter = createCounter();

    const View = retrack<{ client: QueryClient; counter: State<Counter> }>(({ client: fresh, counter: snap }) => (
      <span data-testid="value">
        {fresh.config.retries},{snap.count}
      </span>
    ));

    expect(() => render(<View client={client} counter={counter} />)).not.toThrow();
    expect(screen.getByTestId("value").textContent).toBe("3,0");
  });

  it("re-renders the boundary for a field read only by an unwrapped descendant", async () => {
    interface Screen {
      view: string;
      detail: string;
      unread: number;
    }

    const state = createState<Screen>(() => ({ view: "home", detail: "none", unread: 0 }));
    const renders = { boundary: 0, leaf: 0 };

    const Leaf: FC<{ context: { state: State<Screen> } }> = ({ context }) => {
      renders.leaf += 1;

      return <span data-testid="detail">{context.state.detail}</span>;
    };

    const Boundary = retrack<{ context: { state: State<Screen> } }>(({ context }) => {
      renders.boundary += 1;

      return (
        <>
          <span data-testid="view">{context.state.view}</span>
          <Leaf context={context} />
        </>
      );
    });

    render(<Boundary context={{ state }} />);

    expect(renders).toEqual({ boundary: 1, leaf: 1 });

    await act(async () => {
      state.mutate((mutable) => {
        mutable.detail = "card";
      });
    });

    expect(screen.getByTestId("detail").textContent).toBe("card");
    expect(renders).toEqual({ boundary: 2, leaf: 2 });

    await act(async () => {
      state.mutate((mutable) => {
        mutable.unread += 1;
      });
    });

    expect(renders).toEqual({ boundary: 2, leaf: 2 });
  });
});
