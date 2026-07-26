// @vitest-environment jsdom

import { act, render, screen } from "@testing-library/react";
import { memo, useEffect, type FC } from "react";

import { createMutableState } from "../createMutableState";
import { TrackedMap } from "../tracked/trackedMap";
import { isWrapper } from "./boundary";
import { scope } from "./scope";
import { useMutableState } from "./useMutableState";

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
});
