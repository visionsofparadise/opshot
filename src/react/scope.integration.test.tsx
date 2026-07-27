// @vitest-environment jsdom

import { act, render, screen } from "@testing-library/react";
import { memo, useEffect, useLayoutEffect, useRef, useState, type FC } from "react";

import { createMutableState } from "../createMutableState";
import { TrackedMap } from "../tracked/trackedMap";
import { isWrapper } from "./boundary";
import { scope } from "./scope";
import { useMutableState } from "./useMutableState";

const valtioSubscribeCounts = vi.hoisted(() => ({ subscribes: 0, unsubscribes: 0 }));

vi.mock("valtio/vanilla", async () => {
	const actual = await vi.importActual<typeof import("valtio/vanilla")>("valtio/vanilla");
	const actualSubscribe = actual.subscribe;

	return {
		...actual,
		subscribe: (...args: Parameters<typeof actualSubscribe>) => {
			valtioSubscribeCounts.subscribes += 1;

			const unsubscribe = actualSubscribe(...args);

			return () => {
				valtioSubscribeCounts.unsubscribes += 1;
				unsubscribe();
			};
		},
	};
});

describe("scope", () => {
	it("rerenders a scoped child when a read prop field changes", () => {
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

		act(() => {
			const state = (globalThis as { __scoped?: { count: number; other: number } }).__scoped;

			if (state === undefined) throw new Error("missing state");

			state.other = 1;
		});

		expect(childRenders).toBe(1);

		act(() => {
			const state = (globalThis as { __scoped?: { count: number; other: number } }).__scoped;

			if (state === undefined) throw new Error("missing state");

			state.count = 2;
		});

		expect(childRenders).toBe(2);
		expect(screen.getByTestId("value").textContent).toBe("2");
	});

	it("heals mutations that land before passive subscription attach", () => {
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

		const Boundary = scope<{ state: { count: number } }>(({ state }) => {
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

			return <Boundary state={state} />;
		};

		render(<Parent />);
		expect(screen.getByTestId("early").textContent).toBe("7");
		expect(boundaryRenders).toBe(2);
	});

	it("free-rider: unwrapped child reads ride the scoped boundary", () => {
		let boundaryRenders = 0;
		let leafRenders = 0;
		let stateRef: { view: string; detail: number; other: number } | undefined;

		const Leaf: FC<{ item: { view: string; detail: number; other: number } }> = ({ item }) => {
			leafRenders += 1;

			return <span data-testid="detail">{item.detail}</span>;
		};

		const Boundary = scope<{ state: { view: string; detail: number; other: number } }>(({ state }) => {
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

			return <Boundary state={state} />;
		};

		render(<Parent />);
		expect(boundaryRenders).toBe(1);
		expect(leafRenders).toBe(1);

		act(() => {
			if (stateRef === undefined) throw new Error("missing state");

			stateRef.detail = 5;
		});

		expect(boundaryRenders).toBe(2);
		expect(leafRenders).toBe(2);
		expect(screen.getByTestId("detail").textContent).toBe("5");

		act(() => {
			if (stateRef === undefined) throw new Error("missing state");

			stateRef.other = 1;
		});

		expect(boundaryRenders).toBe(2);
		expect(leafRenders).toBe(2);
	});

	it("versioned identity through React.memo retains sibling wrappers", () => {
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

		act(() => {
			if (stateRef === undefined) throw new Error("missing state");

			stateRef.other = 1;
		});

		expect(parentRenders).toBe(2);
		expect(childRenders).toBe(1);
		expect(screen.getByTestId("x").textContent).toBe("1");

		act(() => {
			if (stateRef === undefined) throw new Error("missing state");

			stateRef.obj.x = 9;
		});

		expect(parentRenders).toBe(3);
		expect(childRenders).toBe(2);
		expect(screen.getByTestId("x").textContent).toBe("9");
	});

	it("subscribes once per source set rather than once per render", () => {
		const state = createMutableState({ count: 0, other: 0 });
		let renders = 0;

		const View = scope<{ state: { count: number; other: number } }>(({ state: scoped }) => {
			renders += 1;

			return <span data-testid="count">{scoped.count}</span>;
		});

		valtioSubscribeCounts.subscribes = 0;
		valtioSubscribeCounts.unsubscribes = 0;

		render(<View state={state} />);
		expect(renders).toBe(1);
		expect(valtioSubscribeCounts.subscribes).toBe(1);

		for (let next = 1; next <= 5; next += 1) {
			act(() => {
				state.count = next;
			});
		}

		expect(renders).toBe(6);
		expect(screen.getByTestId("count").textContent).toBe("5");
		expect(valtioSubscribeCounts.subscribes).toBe(1);
		expect(valtioSubscribeCounts.unsubscribes).toBe(0);

		act(() => {
			state.other = 1;
		});

		expect(renders).toBe(6);
		expect(valtioSubscribeCounts.subscribes).toBe(1);
		expect(valtioSubscribeCounts.unsubscribes).toBe(0);
	});

	it("renders a memoized component as an element and keeps it updating", () => {
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

		act(() => {
			if (stateRef === undefined) throw new Error("missing state");

			stateRef.count = 3;
		});

		expect(renders).toBe(2);
		expect(screen.getByTestId("memo-count").textContent).toBe("3");
	});

	it("respects maxDepth and does not wrap states beyond it", () => {
		const deep = createMutableState({ label: "deep" });
		const holder = { a: { b: { c: { d: deep } } } };

		const Shallow = scope<{ holder: typeof holder }>(
			({ holder: h }) => <span data-testid="label">{(h.a.b.c.d as { label: string }).label}</span>,
			{ maxDepth: 2 },
		);

		render(<Shallow holder={holder} />);
		expect(screen.getByTestId("label").textContent).toBe("deep");
		expect(isWrapper((holder.a.b.c as { d: object }).d)).toBe(false);
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

		act(() => {
			if (stateRef === undefined) throw new Error("missing state");

			stateRef.unrelated = "changed";
		});

		expect(renders).toBe(1);

		act(() => {
			if (stateRef === undefined) throw new Error("missing state");

			stateRef.map.set("b", { label: "two" });
		});

		expect(renders).toBe(2);
		expect(screen.getByTestId("size").textContent).toBe("2");
	});

	it("tracks method-interior reads end-to-end", () => {
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

		act(() => {
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
});
