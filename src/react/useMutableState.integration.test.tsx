// @vitest-environment jsdom

import { act, render, screen } from "@testing-library/react";
import { useEffect, useLayoutEffect, useRef, type FC } from "react";

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

describe("useMutableState", () => {
	it("rerenders on tracked mutation and preserves read-your-writes", () => {
		let latest = 0;
		const Counter: FC = () => {
			const state = useMutableState({ count: 0 });

			latest = state.count;

			return (
				<button
					type="button"
					onClick={() => {
						state.count += 1;
						latest = state.count;
					}}
				>
					{state.count}
				</button>
			);
		};

		render(<Counter />);
		expect(screen.getByRole("button").textContent).toBe("0");

		act(() => {
			screen.getByRole("button").click();
		});

		expect(latest).toBe(1);
		expect(screen.getByRole("button").textContent).toBe("1");
	});

	it("does not rerender for unread fields", () => {
		let renders = 0;
		const Reader: FC = () => {
			const state = useMutableState({ a: 0, b: 0 });

			renders += 1;

			useEffect(() => {
				(globalThis as { __state?: { a: number; b: number } }).__state = state;
			});

			return <span>{state.a}</span>;
		};

		render(<Reader />);
		expect(renders).toBe(1);

		act(() => {
			const state = (globalThis as { __state?: { a: number; b: number } }).__state;

			if (state === undefined) throw new Error("missing state");

			state.b = 1;
		});

		expect(renders).toBe(1);

		act(() => {
			const state = (globalThis as { __state?: { a: number; b: number } }).__state;

			if (state === undefined) throw new Error("missing state");

			state.a = 2;
		});

		expect(renders).toBe(2);
		expect(screen.getByText("2")).toBeTruthy();
	});

	it("heals mutations that land before passive subscription attach", () => {
		const Early: FC = () => {
			const state = useMutableState({ count: 0 });
			const mutated = useRef(false);

			useLayoutEffect(() => {
				if (mutated.current) return;

				mutated.current = true;
				state.count = 7;
			});

			return <span>{state.count}</span>;
		};

		render(<Early />);
		expect(screen.getByText("7")).toBeTruthy();
	});

	it("handler reads subscribe until the next render drops them", () => {
		let renders = 0;
		let stateRef: { count: number; extra: number } | undefined;

		const Reader: FC = () => {
			const state = useMutableState({ count: 0, extra: 0 });

			renders += 1;
			stateRef = state;

			return <span>{state.count}</span>;
		};

		render(<Reader />);
		expect(renders).toBe(1);

		act(() => {
			if (stateRef === undefined) throw new Error("missing state");

			stateRef.extra += 1;
		});

		if (renders === 1) {
			act(() => {
				if (stateRef === undefined) throw new Error("missing state");

				stateRef.extra = 10;
			});
		}

		expect(renders).toBe(2);

		const afterSubscribedRender = renders;

		act(() => {
			if (stateRef === undefined) throw new Error("missing state");

			stateRef.extra = 99;
		});

		expect(renders).toBe(afterSubscribedRender);
	});

	it("keeps a non-reading owner silent for a top-level write through its handle", () => {
		let renders = 0;
		let stateRef: { count: number; box: { value: number } } | undefined;

		const Owner: FC = () => {
			const state = useMutableState({ count: 0, box: { value: 0 } });

			renders += 1;
			stateRef = state;

			return null;
		};

		render(<Owner />);
		expect(renders).toBe(1);

		act(() => {
			if (stateRef === undefined) throw new Error("missing state");

			stateRef.count = 1;
		});

		expect(renders).toBe(1);
	});

	it("rerenders a non-reading owner for a nested write, which records a read on the way in", () => {
		let renders = 0;
		let stateRef: { count: number; box: { value: number } } | undefined;

		const Owner: FC = () => {
			const state = useMutableState({ count: 0, box: { value: 0 } });

			renders += 1;
			stateRef = state;

			return null;
		};

		render(<Owner />);
		expect(renders).toBe(1);

		act(() => {
			if (stateRef === undefined) throw new Error("missing state");

			stateRef.box.value = 1;
		});

		expect(renders).toBe(2);
	});

	it("subscribes once for its lifetime rather than once per render", () => {
		let renders = 0;
		let stateRef: { count: number; other: number } | undefined;

		const View: FC = () => {
			const state = useMutableState({ count: 0, other: 0 });

			renders += 1;
			stateRef = state;

			return <span>{state.count}</span>;
		};

		valtioSubscribeCounts.subscribes = 0;
		valtioSubscribeCounts.unsubscribes = 0;

		render(<View />);
		expect(renders).toBe(1);
		expect(valtioSubscribeCounts.subscribes).toBe(1);

		for (let next = 1; next <= 5; next += 1) {
			act(() => {
				if (stateRef === undefined) throw new Error("missing state");

				stateRef.count = next;
			});
		}

		expect(renders).toBe(6);
		expect(screen.getByText("5")).toBeTruthy();
		expect(valtioSubscribeCounts.subscribes).toBe(1);
		expect(valtioSubscribeCounts.unsubscribes).toBe(0);

		act(() => {
			if (stateRef === undefined) throw new Error("missing state");

			stateRef.other = 1;
		});

		expect(renders).toBe(6);
		expect(valtioSubscribeCounts.subscribes).toBe(1);
		expect(valtioSubscribeCounts.unsubscribes).toBe(0);
	});
});
