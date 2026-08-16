// @vitest-environment jsdom

import { act, render, screen } from "@testing-library/react";
import {
	Component,
	memo,
	StrictMode,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
	type FC,
	type ReactNode,
} from "react";

import { createMutableState } from "../createMutableState";
import { TrackedMap } from "../tracked/trackedMap";
import { transact } from "../transact/transact";
import { isReadProxy } from "./readTracker";
import { isRendering } from "./renderPhase";
import { scope } from "./scope";
import { useMutableState } from "./useMutableState";

const subscribeCounts = vi.hoisted(() => ({ subscribes: 0, unsubscribes: 0 }));

vi.mock("../subscribe", async () => {
	const actual = await vi.importActual<typeof import("../subscribe")>("../subscribe");
	const actualSubscribe = actual.subscribe;

	return {
		...actual,
		subscribe: (...args: Parameters<typeof actualSubscribe>) => {
			subscribeCounts.subscribes += 1;

			const unsubscribe = actualSubscribe(...args);

			return () => {
				subscribeCounts.unsubscribes += 1;
				unsubscribe();
			};
		},
	};
});

describe("scope", () => {
	it("rerenders a scoped child when a read prop field changes", async () => {
		let childRenders = 0;

		const Child = scope<{ state: { count: number; other: number } }>(({ state }) => {
			childRenders += 1;

			return <span data-testid="value">{state.count}</span>;
		});

		const Parent: FC = () => {
			const state = useMutableState({ count: 0, other: 0 });

			useEffect(() => {
				(globalThis as { __scoped?: { count: number; other: number } }).__scoped = state;
			});

			return <Child state={state} />;
		};

		render(<Parent />);
		expect(screen.getByTestId("value").textContent).toBe("0");
		expect(childRenders).toBe(1);

		await act(async () => {
			const state = (globalThis as { __scoped?: { count: number; other: number } }).__scoped;

			if (state === undefined) throw new Error("missing state");

			state.other = 1;
		});

		expect(childRenders).toBe(1);

		await act(async () => {
			const state = (globalThis as { __scoped?: { count: number; other: number } }).__scoped;

			if (state === undefined) throw new Error("missing state");

			state.count = 2;
		});

		expect(childRenders).toBe(2);
		expect(screen.getByTestId("value").textContent).toBe("2");
	});

	it("heals mutations that land before passive subscription attach", async () => {
		let boundaryRenders = 0;

		const Mutator: FC<{ state: { count: number } }> = ({ state }) => {
			const mutated = useRef(false);

			useLayoutEffect(() => {
				if (mutated.current) return;

				mutated.current = true;
				state.count = 7;
			});

			return null;
		};

		const Scoped = scope<{ state: { count: number } }>(({ state }) => {
			boundaryRenders += 1;

			return (
				<div>
					<span data-testid="early">{state.count}</span>
					<Mutator state={state} />
				</div>
			);
		});

		const Parent: FC = () => {
			const state = useMutableState({ count: 0 });

			return <Scoped state={state} />;
		};

		render(<Parent />);
		expect(screen.getByTestId("early").textContent).toBe("7");
		expect(boundaryRenders).toBe(2);
	});

	it("free-rider: unwrapped child reads ride the scoped boundary", async () => {
		let boundaryRenders = 0;
		let leafRenders = 0;
		let stateRef: { view: string; detail: number; other: number } | undefined;

		const Leaf: FC<{ item: { view: string; detail: number; other: number } }> = ({ item }) => {
			leafRenders += 1;

			return <span data-testid="detail">{item.detail}</span>;
		};

		const Scoped = scope<{ state: { view: string; detail: number; other: number } }>(({ state }) => {
			boundaryRenders += 1;

			return (
				<div>
					<span data-testid="view">{state.view}</span>
					<Leaf item={state} />
				</div>
			);
		});

		const Parent: FC = () => {
			const state = useMutableState({ view: "v", detail: 0, other: 0 });

			useEffect(() => {
				stateRef = state;
			});

			return <Scoped state={state} />;
		};

		render(<Parent />);
		expect(boundaryRenders).toBe(1);
		expect(leafRenders).toBe(1);

		await act(async () => {
			if (stateRef === undefined) throw new Error("missing state");

			stateRef.detail = 5;
		});

		expect(boundaryRenders).toBe(2);
		expect(leafRenders).toBe(2);
		expect(screen.getByTestId("detail").textContent).toBe("5");

		await act(async () => {
			if (stateRef === undefined) throw new Error("missing state");

			stateRef.other = 1;
		});

		expect(boundaryRenders).toBe(2);
		expect(leafRenders).toBe(2);
	});

	it("versioned identity through React.memo retains sibling readProxies", async () => {
		let parentRenders = 0;
		let childRenders = 0;
		let stateRef: { other: number; obj: { x: number } } | undefined;

		const MemoChild = memo<{ obj: { x: number } }>(({ obj }) => {
			childRenders += 1;

			return <span data-testid="x">{obj.x}</span>;
		});

		const Parent = scope<{ state: { other: number; obj: { x: number } } }>(({ state }) => {
			parentRenders += 1;

			return (
				<div>
					<span data-testid="other">{state.other}</span>
					<MemoChild obj={state.obj} />
				</div>
			);
		});

		const Root: FC = () => {
			const state = useMutableState({ other: 0, obj: { x: 1 } });

			useEffect(() => {
				stateRef = state;
			});

			return <Parent state={state} />;
		};

		render(<Root />);
		expect(parentRenders).toBe(1);
		expect(childRenders).toBe(1);

		await act(async () => {
			if (stateRef === undefined) throw new Error("missing state");

			stateRef.other = 1;
		});

		expect(parentRenders).toBe(2);
		expect(childRenders).toBe(1);
		expect(screen.getByTestId("x").textContent).toBe("1");

		await act(async () => {
			if (stateRef === undefined) throw new Error("missing state");

			stateRef.obj.x = 9;
		});

		expect(parentRenders).toBe(3);
		expect(childRenders).toBe(2);
		expect(screen.getByTestId("x").textContent).toBe("9");
	});

	it("subscribes once per source set rather than once per render", async () => {
		const state = createMutableState({ count: 0, other: 0 });
		let renders = 0;

		const View = scope<{ state: { count: number; other: number } }>(({ state: scoped }) => {
			renders += 1;

			return <span data-testid="count">{scoped.count}</span>;
		});

		subscribeCounts.subscribes = 0;
		subscribeCounts.unsubscribes = 0;

		render(<View state={state} />);
		expect(renders).toBe(1);
		expect(subscribeCounts.subscribes).toBe(1);

		for (let next = 1; next <= 5; next += 1) {
			await act(async () => {
				state.count = next;
			});
		}

		expect(renders).toBe(6);
		expect(screen.getByTestId("count").textContent).toBe("5");
		expect(subscribeCounts.subscribes).toBe(1);
		expect(subscribeCounts.unsubscribes).toBe(0);

		await act(async () => {
			state.other = 1;
		});

		expect(renders).toBe(6);
		expect(subscribeCounts.subscribes).toBe(1);
		expect(subscribeCounts.unsubscribes).toBe(0);
	});

	it("waits for emitOn before rerendering a read field", async () => {
		const queued = new Array<() => void>();
		const state = createMutableState({ count: 0 }, { emitOn: (flush) => queued.push(flush) });
		let renders = 0;

		const View = scope<{ state: { count: number } }>(({ state: scoped }) => {
			renders += 1;

			return <span data-testid="count">{scoped.count}</span>;
		});

		render(<View state={state} />);
		expect(screen.getByTestId("count").textContent).toBe("0");
		expect(renders).toBe(1);

		await act(async () => {
			state.count = 1;
		});

		expect(screen.getByTestId("count").textContent).toBe("0");
		expect(renders).toBe(1);

		await act(async () => {
			queued[0]?.();
		});

		expect(screen.getByTestId("count").textContent).toBe("1");
		expect(renders).toBe(2);
	});

	it("does not rerender when a transact of a read field rolls back", async () => {
		const state = createMutableState({ count: 0 });
		let renders = 0;

		const View = scope<{ state: { count: number } }>(({ state: scoped }) => {
			renders += 1;

			return <span data-testid="count">{scoped.count}</span>;
		});

		render(<View state={state} />);
		expect(renders).toBe(1);

		await act(async () => {
			try {
				transact(state, () => {
					state.count = 1;

					throw new Error("rollback");
				});
			} catch {
				return;
			}
		});

		expect(renders).toBe(1);
		expect(screen.getByTestId("count").textContent).toBe("0");
	});

	it("does not bump from a source-switch unsubscribe flush", async () => {
		const queuedA = new Array<() => void>();
		const queuedB = new Array<() => void>();
		const stateA = createMutableState({ count: 0 }, { emitOn: (flush) => queuedA.push(flush) });
		const stateB = createMutableState({ count: 0 }, { emitOn: (flush) => queuedB.push(flush) });
		let childRenders = 0;
		let switchSource: (() => void) | undefined;

		const Child = scope<{ state: { count: number } }>(({ state }) => {
			childRenders += 1;

			return <span data-testid="count">{state.count}</span>;
		});

		const Parent: FC = () => {
			const [which, setWhich] = useState<"a" | "b">("a");

			switchSource = () => setWhich("b");

			return <Child state={which === "a" ? stateA : stateB} />;
		};

		render(<Parent />);
		expect(childRenders).toBe(1);

		await act(async () => {
			stateA.count = 1;
		});

		expect(childRenders).toBe(1);

		await act(async () => {
			switchSource?.();
		});

		expect(childRenders).toBe(2);
	});

	it("renders a memoized component as an element and keeps it updating", async () => {
		let renders = 0;
		let stateRef: { count: number } | undefined;

		const Inner = memo<{ state: { count: number } }>(({ state }) => {
			renders += 1;

			return <span data-testid="memo-count">{state.count}</span>;
		});

		const View = scope(Inner);

		const Parent: FC = () => {
			const state = useMutableState({ count: 0 });

			useEffect(() => {
				stateRef = state;
			});

			return <View state={state} />;
		};

		render(<Parent />);
		expect(screen.getByTestId("memo-count").textContent).toBe("0");
		expect(renders).toBe(1);

		await act(async () => {
			if (stateRef === undefined) throw new Error("missing state");

			stateRef.count = 3;
		});

		expect(renders).toBe(2);
		expect(screen.getByTestId("memo-count").textContent).toBe("3");
	});

	it("finds a state deeper than the retired depth cap", async () => {
		const deep = createMutableState({ label: "deep" });
		const depth = 15;
		let nested: Record<string, unknown> = { child: deep };

		for (let level = 1; level < depth; level += 1) nested = { child: nested };

		const holder = nested;
		const resolveDeep = (root: Record<string, unknown>): Record<string, unknown> => {
			let current = root;

			for (let level = 0; level < depth; level += 1) current = current.child as Record<string, unknown>;

			return current;
		};

		let renders = 0;
		let seen: object | undefined;

		const Deep = scope<{ holder: Record<string, unknown> }>(({ holder: h }) => {
			renders += 1;
			seen = resolveDeep(h);

			return <span data-testid="label">{(seen as { label: string }).label}</span>;
		});

		render(<Deep holder={holder} />);
		expect(screen.getByTestId("label").textContent).toBe("deep");
		expect(isReadProxy(seen as object)).toBe(true);

		const before = renders;

		await act(async () => {
			deep.label = "deeper";
		});

		expect(renders).toBeGreaterThan(before);
		expect(screen.getByTestId("label").textContent).toBe("deeper");
	});

	it("tracks TrackedMap membership granularly", async () => {
		let renders = 0;
		let stateRef: { map: TrackedMap<string, { label: string }>; unrelated: string } | undefined;

		const View = scope<{ state: { map: TrackedMap<string, { label: string }>; unrelated: string } }>(({ state }) => {
			renders += 1;

			return <span data-testid="size">{state.map.size}</span>;
		});

		const Parent: FC = () => {
			const state = useMutableState({
				map: new TrackedMap<string, { label: string }>([["a", { label: "one" }]]),
				unrelated: "steady",
			});

			useEffect(() => {
				stateRef = state;
			});

			return <View state={state} />;
		};

		render(<Parent />);
		expect(screen.getByTestId("size").textContent).toBe("1");
		expect(renders).toBe(1);

		await act(async () => {
			if (stateRef === undefined) throw new Error("missing state");

			stateRef.unrelated = "changed";
		});

		expect(renders).toBe(1);

		await act(async () => {
			if (stateRef === undefined) throw new Error("missing state");

			stateRef.map.set("b", { label: "two" });
		});

		expect(renders).toBe(2);
		expect(screen.getByTestId("size").textContent).toBe("2");
	});

	it("tracks method-interior reads end-to-end", async () => {
		class Counter {
			count = 0;

			bump(): void {
				this.count += 1;
			}

			read(): number {
				return this.count;
			}
		}

		let renders = 0;
		let stateRef: { counter: Counter } | undefined;

		const View = scope<{ state: { counter: Counter } }>(({ state }) => {
			renders += 1;

			return <span data-testid="count">{state.counter.read()}</span>;
		});

		const Parent: FC = () => {
			const state = useMutableState({ counter: new Counter() });

			useEffect(() => {
				stateRef = state;
			});

			return <View state={state} />;
		};

		render(<Parent />);
		expect(screen.getByTestId("count").textContent).toBe("0");

		await act(async () => {
			if (stateRef === undefined) throw new Error("missing state");

			stateRef.counter.bump();
		});

		expect(renders).toBe(2);
		expect(screen.getByTestId("count").textContent).toBe("1");
	});

	it("three-level chain: each boundary re-renders only for fields it read", async () => {
		interface Doc {
			a: number;
			b: number;
			deep: { x: number };
		}

		const renders = { a: 0, b: 0, c: 0 };
		const seen: Array<number> = [];
		let held: Doc | undefined;

		const C = scope<{ state: Doc }>(({ state }) => {
			renders.c += 1;
			seen.push(state.deep.x);

			return null;
		});

		const B = scope<{ state: Doc }>(({ state }) => {
			renders.b += 1;
			void state.b;

			return <C state={state} />;
		});

		const A: FC = () => {
			const state = useMutableState<Doc>({ a: 0, b: 0, deep: { x: 0 } });

			held = state;
			renders.a += 1;
			void state.a;

			return <B state={state} />;
		};

		render(<A />);
		expect(renders).toEqual({ a: 1, b: 1, c: 1 });
		expect(seen).toEqual([0]);

		await act(async () => {
			if (held === undefined) throw new Error("missing state");

			held.deep.x = 1;
		});
		expect(renders).toEqual({ a: 1, b: 1, c: 2 });
		expect(seen).toEqual([0, 1]);

		await act(async () => {
			if (held === undefined) throw new Error("missing state");

			held.a = 1;
		});
		expect(renders).toEqual({ a: 2, b: 1, c: 2 });
		expect(seen).toEqual([0, 1]);

		await act(async () => {
			if (held === undefined) throw new Error("missing state");

			held.b = 1;
		});
		expect(renders).toEqual({ a: 2, b: 2, c: 2 });
		expect(seen).toEqual([0, 1]);

		await act(async () => {
			if (held === undefined) throw new Error("missing state");

			held.deep.x = 2;
		});
		expect(renders).toEqual({ a: 2, b: 2, c: 3 });
		expect(seen).toEqual([0, 1, 2]);
	});

	it("free-rider leaf under a bailing boundary still updates on a field only it reads", async () => {
		interface Doc {
			a: number;
			b: number;
			c: number;
		}

		let ownerRenders = 0;
		let midRenders = 0;
		let leafRenders = 0;
		const leafSaw: Array<number> = [];
		let held: Doc | undefined;

		const Leaf: FC<{ state: Doc }> = ({ state }) => {
			leafRenders += 1;
			leafSaw.push(state.c);

			return <span data-testid="c">{state.c}</span>;
		};

		const Mid = scope<{ state: Doc }>(({ state }) => {
			midRenders += 1;
			void state.b;

			return <Leaf state={state} />;
		});

		const Owner: FC = () => {
			const state = useMutableState<Doc>({ a: 0, b: 0, c: 0 });

			held = state;
			ownerRenders += 1;
			void state.a;

			return <Mid state={state} />;
		};

		render(<Owner />);
		expect({ owner: ownerRenders, mid: midRenders, leaf: leafRenders }).toEqual({
			owner: 1,
			mid: 1,
			leaf: 1,
		});

		await act(async () => {
			if (held === undefined) throw new Error("missing state");

			held.a = 1;
		});
		expect({ owner: ownerRenders, mid: midRenders, leaf: leafRenders }).toEqual({
			owner: 2,
			mid: 1,
			leaf: 1,
		});

		await act(async () => {
			if (held === undefined) throw new Error("missing state");

			held.c = 5;
		});
		expect({ owner: ownerRenders, mid: midRenders, leaf: leafRenders }).toEqual({
			owner: 2,
			mid: 2,
			leaf: 2,
		});
		expect(leafSaw).toEqual([0, 5]);
		expect(screen.getByTestId("c").textContent).toBe("5");
	});

	it("re-renders a boundary when a non-state prop changes even if reads did not", async () => {
		interface Doc {
			count: number;
		}

		let childRenders = 0;
		let held: Doc | undefined;
		let setLabel: ((value: string) => void) | undefined;

		const Child = scope<{ state: Doc; label: string }>(({ state, label }) => {
			childRenders += 1;
			void state.count;

			return (
				<span data-testid="row">
					{label}:{state.count}
				</span>
			);
		});

		const Parent: FC = () => {
			const state = useMutableState<Doc>({ count: 0 });
			const [label, setLabelState] = useState("first");

			held = state;
			setLabel = setLabelState;

			return <Child state={state} label={label} />;
		};

		render(<Parent />);
		expect(childRenders).toBe(1);
		expect(screen.getByTestId("row").textContent).toBe("first:0");

		await act(async () => {
			setLabel?.("second");
		});
		expect(childRenders).toBe(2);
		expect(screen.getByTestId("row").textContent).toBe("second:0");

		await act(async () => {
			if (held === undefined) throw new Error("missing state");

			held.count = 1;
		});
		expect(childRenders).toBe(3);
		expect(screen.getByTestId("row").textContent).toBe("second:1");
	});

	it("a boundary blocked across parent renders still advances and re-renders on its own field", async () => {
		interface Doc {
			a: number;
			b: number;
		}

		let ownerRenders = 0;
		let childRenders = 0;
		const childSaw: Array<number> = [];
		let held: Doc | undefined;

		const Child = scope<{ state: Doc }>(({ state }) => {
			childRenders += 1;
			childSaw.push(state.b);

			return <span data-testid="b">{state.b}</span>;
		});

		const Owner: FC = () => {
			const state = useMutableState<Doc>({ a: 0, b: 0 });

			held = state;
			ownerRenders += 1;
			void state.a;

			return <Child state={state} />;
		};

		render(<Owner />);
		expect({ owner: ownerRenders, child: childRenders }).toEqual({ owner: 1, child: 1 });
		expect(childSaw).toEqual([0]);

		await act(async () => {
			if (held === undefined) throw new Error("missing state");

			held.a = 1;
		});
		expect({ owner: ownerRenders, child: childRenders }).toEqual({ owner: 2, child: 1 });

		await act(async () => {
			if (held === undefined) throw new Error("missing state");

			held.a = 2;
		});
		expect({ owner: ownerRenders, child: childRenders }).toEqual({ owner: 3, child: 1 });

		await act(async () => {
			if (held === undefined) throw new Error("missing state");

			held.b = 9;
		});
		expect({ owner: ownerRenders, child: childRenders }).toEqual({ owner: 3, child: 2 });
		expect(childSaw).toEqual([0, 9]);
		expect(screen.getByTestId("b").textContent).toBe("9");
	});

	it("subscribes a descendant that re-renders on its own local state and reads a new field", async () => {
		interface Doc {
			title: string;
			details: string;
		}

		let expand: (() => void) | undefined;

		const Details = scope<{ state: Doc }>(({ state }) => {
			const [expanded, setExpanded] = useState(false);

			expand = () => setExpanded(true);

			return <span data-testid="details">{expanded ? state.details : state.title}</span>;
		});

		const Parent: FC = () => {
			const state = useMutableState<Doc>(() => ({ title: "t", details: "hidden" }));

			useEffect(() => {
				(globalThis as { __doc?: Doc }).__doc = state;
			});

			return <Details state={state} />;
		};

		render(<Parent />);
		expect(screen.getByTestId("details").textContent).toBe("t");

		await act(async () => {
			expand?.();
		});

		expect(screen.getByTestId("details").textContent).toBe("hidden");

		await act(async () => {
			const doc = (globalThis as { __doc?: Doc }).__doc;

			if (doc === undefined) throw new Error("missing state");

			doc.details = "revealed";
		});

		expect(screen.getByTestId("details").textContent).toBe("revealed");
	});

	it("subscribes a descendant re-rendering on its own local state under StrictMode", async () => {
		interface Doc {
			title: string;
			details: string;
		}

		let expand: (() => void) | undefined;
		let held: Doc | undefined;

		const Details = scope<{ state: Doc }>(({ state }) => {
			const [expanded, setExpanded] = useState(false);

			expand = () => setExpanded(true);

			return <span data-testid="strict">{expanded ? state.details : state.title}</span>;
		});

		const Parent: FC = () => {
			const state = useMutableState<Doc>(() => ({ title: "t", details: "hidden" }));

			held = state;

			return <Details state={state} />;
		};

		render(
			<StrictMode>
				<Parent />
			</StrictMode>,
		);

		await act(async () => {
			expand?.();
		});

		expect(screen.getByTestId("strict").textContent).toBe("hidden");

		await act(async () => {
			if (held === undefined) throw new Error("missing state");

			held.details = "revealed";
		});

		expect(screen.getByTestId("strict").textContent).toBe("revealed");
	});

	it("keeps a class component rendering under a boundary reactive", async () => {
		interface Doc {
			n: number;
		}

		let held: Doc | undefined;

		class Reader extends Component<{ state: Doc }> {
			override render(): ReactNode {
				return <span data-testid="class">{this.props.state.n}</span>;
			}
		}

		const Scoped = scope(Reader);

		const Parent: FC = () => {
			const state = useMutableState<Doc>(() => ({ n: 0 }));

			held = state;

			return <Scoped state={state} />;
		};

		render(<Parent />);
		expect(screen.getByTestId("class").textContent).toBe("0");

		for (const next of [1, 2, 3]) {
			await act(async () => {
				if (held === undefined) throw new Error("missing state");

				held.n = next;
			});

			expect(screen.getByTestId("class").textContent).toBe(String(next));
		}
	});

	it("reads the render phase from the React it is built against", async () => {
		let bump: (() => void) | undefined;
		const duringRender = new Array<boolean>();
		const duringEffect = new Array<boolean>();

		const Probe: FC = () => {
			const [n, setN] = useState(0);

			bump = () => setN(n + 1);
			duringRender.push(isRendering());

			useEffect(() => {
				duringEffect.push(isRendering());
			});

			return <span data-testid="probe">{n}</span>;
		};

		const Parent: FC = () => {
			const state = useMutableState({ n: 0 });

			return (
				<>
					<span>{state.n}</span>
					<Probe />
				</>
			);
		};

		render(<Parent />);

		await act(async () => {
			bump?.();
		});

		expect(duringRender[duringRender.length - 1]).toBe(true);
		expect(duringEffect[duringEffect.length - 1]).toBe(false);
		expect(isRendering()).toBe(false);
	});

	it("records no read from an effect, an event handler, or outside React", async () => {
		interface Counter {
			shown: number;
			hidden: number;
		}

		let renders = 0;
		let held: Counter | undefined;
		let bump: (() => void) | undefined;
		const readOutside = new Array<number>();

		const View = scope<{ state: Counter }>(({ state }) => {
			const [local, setLocal] = useState(0);

			renders += 1;
			bump = () => setLocal(local + 1);

			useEffect(() => {
				readOutside.push(state.hidden);
			});

			return (
				<button data-testid="button" onClick={() => readOutside.push(state.hidden)}>
					{state.shown}
					{local}
				</button>
			);
		});

		const Parent: FC = () => {
			const state = useMutableState<Counter>(() => ({ shown: 0, hidden: 0 }));

			held = state;

			return <View state={state} />;
		};

		render(<Parent />);

		await act(async () => {
			bump?.();
		});

		await act(async () => {
			screen.getByTestId("button").click();
		});

		if (held === undefined) throw new Error("missing state");

		readOutside.push(held.hidden);

		const before = renders;

		await act(async () => {
			if (held === undefined) throw new Error("missing state");

			held.hidden += 1;
		});

		expect(renders).toBe(before);

		await act(async () => {
			if (held === undefined) throw new Error("missing state");

			held.shown += 1;
		});

		expect(renders).toBe(before + 1);
	});

	it("gives a readProxy the object protocol of the value it wraps", async () => {
		interface Shape {
			name: string;
			items: Array<number>;
			nested: { n: number };
			map: TrackedMap<string, number>;
		}

		let readProxy: Shape | undefined;

		const Child = scope<{ state: Shape }>(({ state }) => {
			readProxy = state;

			return <span data-testid="name">{state.name}</span>;
		});

		const Parent: FC = () => {
			const state = useMutableState<Shape>(() => ({
				name: "doc",
				items: [1, 2, 3],
				nested: { n: 1 },
				map: new TrackedMap<string, number>([["k", 1]]),
			}));

			return <Child state={state} />;
		};

		render(<Parent />);

		if (readProxy === undefined) throw new Error("missing readProxy");

		expect(isReadProxy(readProxy)).toBe(true);
		expect(Array.isArray(readProxy.items)).toBe(true);
		expect(readProxy.items instanceof Array).toBe(true);
		expect(readProxy.nested instanceof Object).toBe(true);
		expect(readProxy.map instanceof TrackedMap).toBe(true);
		expect(Object.keys(readProxy.items)).toEqual(["0", "1", "2"]);
		expect(Object.entries(readProxy.nested)).toEqual([["n", 1]]);
		expect([...readProxy.items]).toEqual([1, 2, 3]);
		expect({ ...readProxy.nested }).toEqual({ n: 1 });
		expect(JSON.stringify(readProxy.items)).toBe("[1,2,3]");
		expect(JSON.stringify(readProxy.nested)).toBe('{"n":1}');
		expect(JSON.parse(JSON.stringify(readProxy))).toMatchObject({ name: "doc", items: [1, 2, 3], nested: { n: 1 } });

		const iterated = new Array<number>();

		for (const item of readProxy.items) iterated.push(item);

		expect(iterated).toEqual([1, 2, 3]);
		expect(readProxy.items.length).toBe(3);
		expect(readProxy.map.get("k")).toBe(1);
		expect(() => structuredClone(readProxy)).toThrow();
		expect(() => structuredClone(createMutableState({ n: 1 }))).toThrow();
	});

	it("completes preventExtensions, freeze, and seal through a readProxy while writes through it keep working", async () => {
		interface Shape {
			count: number;
			items: Array<number>;
		}

		let readProxy: Shape | undefined;

		const Child = scope<{ state: Shape }>(({ state }) => {
			readProxy = state;

			return <span data-testid="count">{state.count}</span>;
		});

		const Parent: FC = () => {
			const state = useMutableState<Shape>(() => ({ count: 0, items: [1, 2] }));

			return <Child state={state} />;
		};

		render(<Parent />);

		const wrapped = readProxy;

		if (wrapped === undefined) throw new Error("missing readProxy");

		Object.preventExtensions(wrapped);
		Object.seal(wrapped.items);

		await act(async () => {
			wrapped.count = 1;
			wrapped.items[0] = 9;
		});

		expect(screen.getByTestId("count").textContent).toBe("1");
		expect([...wrapped.items]).toEqual([9, 2]);

		Object.freeze(wrapped);

		expect(Object.isFrozen(wrapped)).toBe(true);
	});
});

describe("per-key comparison", () => {
	const mountReader = <T extends object>(state: T, read: (value: T) => ReactNode) => {
		let renders = 0;

		const View = scope<{ state: T }>(({ state: scoped }) => {
			renders += 1;

			return <span data-testid="read">{read(scoped)}</span>;
		});

		render(<View state={state} />);

		return {
			renders: () => renders,
			text: () => screen.getByTestId("read").textContent,
		};
	};

	it("leaves an unread key of a read node silent", async () => {
		const state = createMutableState({ box: { n: 1, m: 1 } });
		const reader = mountReader(state, (value) => value.box.n);

		await act(async () => {
			state.box.m = 5;
		});

		expect(reader.renders()).toBe(1);
	});

	it("leaves an unread sibling subtree silent", async () => {
		const state = createMutableState({ a: { x: 1 }, b: { y: 1, deep: { z: 1 } } });
		const reader = mountReader(state, (value) => value.a.x);

		await act(async () => {
			state.b.y = 9;
		});
		await act(async () => {
			state.b.deep.z = 9;
		});

		expect(reader.renders()).toBe(1);
	});

	it("keeps a length read silent under element churn and signals on push", async () => {
		const state = createMutableState({ rows: [{ v: 1 }, { v: 2 }] });
		const reader = mountReader(state, (value) => value.rows.length);

		await act(async () => {
			const row = state.rows[0];

			if (row === undefined) throw new Error("missing row");

			row.v = 99;
		});

		expect(reader.renders()).toBe(1);

		await act(async () => {
			state.rows.push({ v: 3 });
		});

		expect(reader.renders()).toBe(2);
		expect(reader.text()).toBe("3");
	});

	it("signals an equal-content replacement under an identity-only read", async () => {
		const state = createMutableState({ box: { n: 1 } });
		const reader = mountReader(state, (value) => typeof value.box);

		await act(async () => {
			state.box = { n: 1 };
		});

		expect(reader.renders()).toBe(2);
	});

	it("signals an equal-content replacement on a recorded parent path", async () => {
		const state = createMutableState({ box: { n: 1 } });
		const reader = mountReader(state, (value) => value.box.n);

		await act(async () => {
			state.box = { n: 1 };
		});

		expect(reader.renders()).toBe(2);
	});

	it("detects a wholesale node replacement through the parent's key", async () => {
		const state = createMutableState<{ box: { n: number; extra?: number } }>({ box: { n: 1 } });
		const reader = mountReader(state, (value) => value.box.n);

		await act(async () => {
			state.box = { n: 99 };
		});

		expect(reader.renders()).toBe(2);
		expect(reader.text()).toBe("99");

		await act(async () => {
			state.box = { n: 99, extra: 1 };
		});

		expect(reader.renders()).toBe(3);
	});

	it("signals an own getter on its dependency and stays silent on an unrelated write", async () => {
		interface Doubler {
			count: number;
			other: number;
			readonly double: number;
		}

		const state = createMutableState({
			count: 2,
			other: 0,
			get double() {
				return this.count * 2;
			},
		} as Doubler);
		const reader = mountReader(state, (value) => value.double);

		await act(async () => {
			state.other = 1;
		});

		expect(reader.renders()).toBe(1);

		await act(async () => {
			state.count = 5;
		});

		expect(reader.renders()).toBe(2);
		expect(reader.text()).toBe("10");
	});

	it("signals an in-place deep change under an identity-only read", async () => {
		const state = createMutableState({ box: { inner: { deep: 1 } } });
		const reader = mountReader(state, (value) => typeof value.box);

		await act(async () => {
			state.box.inner.deep = 2;
		});

		expect(reader.renders()).toBe(2);
	});

	it("leaves an identity-only read silent when a sibling churns", async () => {
		const state = createMutableState({ box: { inner: 1 }, other: { n: 1 } });
		const reader = mountReader(state, (value) => typeof value.box);

		await act(async () => {
			state.other.n = 2;
		});

		expect(reader.renders()).toBe(1);
	});

	it("signals an added key through in and Object.keys reads", async () => {
		const state = createMutableState<{ x: number; y?: number }>({ x: 1 });
		const reader = mountReader(state, (value) => `${"y" in value}:${Object.keys(value).length}`);

		await act(async () => {
			state.y = 2;
		});

		expect(reader.renders()).toBe(2);
		expect(reader.text()).toBe("true:2");
	});

	it("signals a delete of a read key", async () => {
		const state = createMutableState<{ n?: number; keep: number }>({ n: 1, keep: 0 });
		const reader = mountReader(state, (value) => String(value.n));

		await act(async () => {
			delete state.n;
		});

		expect(reader.renders()).toBe(2);
		expect(reader.text()).toBe("undefined");
	});

	it("leaves a TrackedMap read key silent when another key churns", async () => {
		const state = createMutableState({
			map: new TrackedMap<string, number>([
				["a", 1],
				["b", 2],
			]),
		});
		const reader = mountReader(state, (value) => String(value.map.get("a")));

		await act(async () => {
			state.map.set("b", 99);
		});

		expect(reader.renders()).toBe(1);

		await act(async () => {
			state.map.set("a", 42);
		});

		expect(reader.renders()).toBe(2);
		expect(reader.text()).toBe("42");
	});
});
