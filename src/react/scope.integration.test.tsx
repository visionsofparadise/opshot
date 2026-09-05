// @vitest-environment jsdom

import { act, render, screen } from "../../tests/harness";
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
import { handleOf } from "../handle";
import { batch } from "../batch";
import { scope } from "./scope";
import { useMutableState } from "./useMutableState";

describe("§6.2 re-render on a read edge", () => {
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

	it("rerenders when a throwing batch writes a read field", async () => {
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
				batch(() => {
					state.count = 1;

					throw new Error("rollback");
				});
			} catch {
				return;
			}
		});

		expect(renders).toBe(2);
		expect(screen.getByTestId("count").textContent).toBe("1");
	});

	it("shows the live value when a departed source is written and then returned to", async () => {
		const stateA = createMutableState({ count: 0 });
		const stateB = createMutableState({ count: 0 });
		let childRenders = 0;
		let switchSource: ((value: "a" | "b") => void) | undefined;

		const Child = scope<{ state: { count: number } }>(({ state }) => {
			childRenders += 1;

			return <span data-testid="count">{state.count}</span>;
		});

		const Parent: FC = () => {
			const [which, setWhich] = useState<"a" | "b">("a");

			switchSource = setWhich;

			return <Child state={which === "a" ? stateA : stateB} />;
		};

		render(<Parent />);
		expect(childRenders).toBe(1);
		expect(screen.getByTestId("count").textContent).toBe("0");

		await act(async () => {
			switchSource?.("b");
		});

		expect(childRenders).toBe(2);
		expect(screen.getByTestId("count").textContent).toBe("0");

		await act(async () => {
			stateA.count = 1;
		});

		expect(childRenders).toBe(2);

		await act(async () => {
			switchSource?.("a");
		});

		expect(screen.getByTestId("count").textContent).toBe("1");
		expect(childRenders).toBe(3);
	});

	it("§6.2 a change between render and subscription re-renders", () => {
		const queued = new Array<() => void>();
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
			const state = useMutableState({ count: 0 }, { emitOn: (flush) => queued.push(flush) });

			return <Scoped state={state} />;
		};

		render(<Parent />);

		expect(screen.getByTestId("early").textContent).toBe("7");
		expect(boundaryRenders).toBe(2);
		expect(queued).toHaveLength(0);
	});

	it("§6.2 a change to an unread key between render and subscription does not re-render", () => {
		const queued = new Array<() => void>();
		let boundaryRenders = 0;

		const Mutator: FC<{ state: { count: number; other: number } }> = ({ state }) => {
			const mutated = useRef(false);

			useLayoutEffect(() => {
				if (mutated.current) return;

				mutated.current = true;
				state.other = 7;
			});

			return null;
		};

		const Scoped = scope<{ state: { count: number; other: number } }>(({ state }) => {
			boundaryRenders += 1;

			return (
				<div>
					<span data-testid="unread-gap">{state.count}</span>
					<Mutator state={state} />
				</div>
			);
		});

		const Parent: FC = () => {
			const state = useMutableState({ count: 0, other: 0 }, { emitOn: (flush) => queued.push(flush) });

			return <Scoped state={state} />;
		};

		render(<Parent />);

		expect(screen.getByTestId("unread-gap").textContent).toBe("0");
		expect(boundaryRenders).toBe(1);
		expect(queued).toHaveLength(0);
	});

	it("rerenders for a write made while a source was departed", async () => {
		const queuedA = new Array<() => void>();
		const stateA = createMutableState({ count: 0 }, { emitOn: (flush) => queuedA.push(flush) });
		const stateB = createMutableState({ count: 0 });
		let childRenders = 0;
		let switchSource: ((value: "a" | "b") => void) | undefined;

		const Child = scope<{ state: { count: number } }>(({ state }) => {
			childRenders += 1;

			return <span data-testid="departed">{state.count}</span>;
		});

		const Parent: FC = () => {
			const [which, setWhich] = useState<"a" | "b">("a");

			switchSource = setWhich;

			return <Child state={which === "a" ? stateA : stateB} />;
		};

		render(<Parent />);
		expect(childRenders).toBe(1);
		expect(screen.getByTestId("departed").textContent).toBe("0");

		await act(async () => {
			switchSource?.("b");
		});

		expect(childRenders).toBe(2);

		await act(async () => {
			stateA.count = 1;
		});

		expect(childRenders).toBe(2);

		await act(async () => {
			switchSource?.("a");
		});

		expect(screen.getByTestId("departed").textContent).toBe("1");
		expect(childRenders).toBe(3);
	});

	it("subscribes once when the same state is passed on two props", async () => {
		const state = createMutableState({ count: 0 });
		const handle = handleOf(state);
		let renders = 0;

		const View = scope<{ left: { count: number }; right: { count: number } }>(({ left, right }) => {
			renders += 1;

			return <span data-testid="both">{left.count + right.count}</span>;
		});

		render(<View left={state} right={state} />);

		expect(handle?.subscribers.size).toBe(1);
		expect(renders).toBe(1);
		expect(screen.getByTestId("both").textContent).toBe("0");

		await act(async () => {
			state.count = 1;
		});

		expect(renders).toBe(2);
		expect(handle?.subscribers.size).toBe(1);
		expect(screen.getByTestId("both").textContent).toBe("2");
	});

	it("keeps re-rendering a read field after StrictMode remounts in the same tick", async () => {
		const state = createMutableState({ count: 0 });
		let renders = 0;

		const View = scope<{ state: { count: number } }>(({ state: scoped }) => {
			renders += 1;

			return <span data-testid="strict">{scoped.count}</span>;
		});

		render(
			<StrictMode>
				<View state={state} />
			</StrictMode>,
		);

		const before = renders;

		await act(async () => {
			state.count = 1;
		});

		expect(renders).toBeGreaterThan(before);
		expect(screen.getByTestId("strict").textContent).toBe("1");
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
});

describe("§2.2 a scoped component writes read proxies back", () => {
	it("keeps each node's identity through a reorder", async () => {
		let reverse: (() => void) | undefined;
		let write: { frames: Array<{ id: string }> } | undefined;

		const Frames = scope<{ state: { frames: Array<{ id: string }> } }>(({ state }) => {
			reverse = () => {
				state.frames.reverse();
			};

			return <span data-testid="order">{state.frames.map((frame) => frame.id).join(",")}</span>;
		});

		const Parent: FC = () => {
			const state = useMutableState({ frames: [{ id: "a" }, { id: "b" }] });

			useEffect(() => {
				write = createMutableState(state);
			}, [state]);

			return <Frames state={state} />;
		};

		render(<Parent />);

		if (write === undefined) throw new Error("missing state");

		const first = write.frames[0];

		await act(async () => {
			reverse?.();
		});

		expect(screen.getByTestId("order").textContent).toBe("b,a");
		expect(write.frames[1]).toBe(first);
	});
});

describe("§6.1 reads", () => {
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
});

describe("§6.3 scope reachability", () => {
	it("re-renders a nested child that reads a state passed through props", async () => {
		let childRenders = 0;

		const Child = scope<{ state: { count: number } }>(({ state }) => {
			childRenders += 1;

			return <span data-testid="reach">{state.count}</span>;
		});

		const Parent: FC = () => {
			const state = useMutableState({ count: 0 });

			useEffect(() => {
				(globalThis as { __reach?: { count: number } }).__reach = state;
			});

			return <Child state={state} />;
		};

		render(<Parent />);
		expect(screen.getByTestId("reach").textContent).toBe("0");
		expect(childRenders).toBe(1);

		await act(async () => {
			const state = (globalThis as { __reach?: { count: number } }).__reach;

			if (state === undefined) throw new Error("missing state");

			state.count = 1;
		});

		expect(childRenders).toBe(2);
		expect(screen.getByTestId("reach").textContent).toBe("1");
	});
});
