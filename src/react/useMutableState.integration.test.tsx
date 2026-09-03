// @vitest-environment jsdom

import { act, fireEvent, render, screen } from "../../tests/harness";
import { useLayoutEffect, useRef, useState, type FC } from "react";

import { createMutableState } from "../createMutableState";
import { isSameIdentity } from "../identity";
import { batch } from "../batch";
import { scope } from "./scope";
import { useMutableState } from "./useMutableState";

describe("§6.2 re-render on a read edge", () => {
	it("rerenders on tracked mutation and preserves read-your-writes", async () => {
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

		await act(async () => {
			screen.getByRole("button").click();
		});

		expect(latest).toBe(1);
		expect(screen.getByRole("button").textContent).toBe("1");
	});

	it("does not rerender for unread fields", async () => {
		let renders = 0;
		let stateRef: { a: number; b: number } | undefined;

		const Reader: FC = () => {
			const state = useMutableState({ a: 0, b: 0 });

			renders += 1;
			stateRef = state;

			return <span>{state.a}</span>;
		};

		render(<Reader />);
		expect(renders).toBe(1);

		await act(async () => {
			if (stateRef === undefined) throw new Error("missing state");

			stateRef.b = 1;
		});

		expect(renders).toBe(1);

		await act(async () => {
			if (stateRef === undefined) throw new Error("missing state");

			stateRef.a = 2;
		});

		expect(renders).toBe(2);
		expect(screen.getByText("2")).toBeTruthy();
	});

	it("handler reads do not subscribe the component", async () => {
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

		await act(async () => {
			if (stateRef === undefined) throw new Error("missing state");

			stateRef.extra += 1;
		});

		expect(renders).toBe(1);

		await act(async () => {
			if (stateRef === undefined) throw new Error("missing state");

			stateRef.count += 1;
		});

		expect(renders).toBe(2);
	});

	it("keeps a non-reading owner silent for a top-level write through its readProxy", async () => {
		let renders = 0;
		let stateRef: { count: number } | undefined;

		const Owner: FC = () => {
			const state = useMutableState({ count: 0 });

			renders += 1;
			stateRef = state;

			return null;
		};

		render(<Owner />);
		expect(renders).toBe(1);

		await act(async () => {
			if (stateRef === undefined) throw new Error("missing state");

			stateRef.count = 1;
		});

		expect(renders).toBe(1);
	});

	it("waits for emitOn before rerendering a read field", async () => {
		const queued = new Array<() => void>();
		let renders = 0;
		let stateRef: { count: number } | undefined;

		const View: FC = () => {
			const state = useMutableState({ count: 0 }, { emitOn: (flush) => queued.push(flush) });

			renders += 1;
			stateRef = state;

			return <span data-testid="count">{state.count}</span>;
		};

		render(<View />);
		expect(screen.getByTestId("count").textContent).toBe("0");
		expect(renders).toBe(1);

		await act(async () => {
			if (stateRef === undefined) throw new Error("missing state");

			stateRef.count = 1;
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
		let renders = 0;
		let stateRef: { count: number } | undefined;

		const View: FC = () => {
			const state = useMutableState({ count: 0 });

			renders += 1;
			stateRef = state;

			return <span data-testid="count">{state.count}</span>;
		};

		render(<View />);
		expect(renders).toBe(1);

		await act(async () => {
			const state = stateRef;

			if (state === undefined) throw new Error("missing state");

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

	it("a non-reading owner stays at one render across three scoped child increments", async () => {
		interface User {
			name: string;
			age: number;
		}

		const renders = { parent: 0, child: 0 };

		const Child = scope<{ user: User }>(({ user }) => {
			renders.child += 1;

			return <p>{user.age}</p>;
		});

		const Parent = () => {
			const user = useMutableState<User>({ name: "Ada", age: 36 });

			renders.parent += 1;

			return (
				<>
					<button
						type="button"
						onClick={() => {
							user.age++;
						}}
					>
						+
					</button>
					<Child user={user} />
				</>
			);
		};

		render(<Parent />);

		for (let index = 0; index < 3; index += 1) {
			await act(async () => {
				fireEvent.click(screen.getByRole("button"));
			});
		}

		expect(renders.parent).toBe(1);
		expect(renders.child).toBe(4);
	});

	it("rerenders when properties is a live state that later writes", async () => {
		const existing = createMutableState({ count: 0 });
		let seen: { count: number } | undefined;
		const View: FC = () => {
			const state = useMutableState(existing);

			seen = state;

			return <span data-testid="count">{state.count}</span>;
		};

		render(<View />);

		expect(seen !== undefined && isSameIdentity(seen, existing)).toBe(true);
		expect(screen.getByTestId("count").textContent).toBe("0");

		await act(async () => {
			existing.count = 1;
		});

		expect(screen.getByTestId("count").textContent).toBe("1");
	});

	it("accepts a plain-object properties argument", () => {
		const View: FC = () => {
			const state = useMutableState({ count: 0 });

			return <span data-testid="plain">{state.count}</span>;
		};

		render(<View />);

		expect(screen.getByTestId("plain").textContent).toBe("0");
	});

	it("accepts a properties function", () => {
		const View: FC = () => {
			const state = useMutableState(() => ({ count: 0 }));

			return <span data-testid="factory">{state.count}</span>;
		};

		render(<View />);

		expect(screen.getByTestId("factory").textContent).toBe("0");
	});

	it("§6.2 a change between render and subscription re-renders", () => {
		const queued = new Array<() => void>();
		let renders = 0;

		const Mutator: FC<{ state: { count: number } }> = ({ state }) => {
			const mutated = useRef(false);

			useLayoutEffect(() => {
				if (mutated.current) return;

				mutated.current = true;
				state.count = 7;
			});

			return null;
		};

		const View: FC = () => {
			const state = useMutableState({ count: 0 }, { emitOn: (flush) => queued.push(flush) });

			renders += 1;

			return (
				<div>
					<Mutator state={state} />
					<span data-testid="early">{state.count}</span>
				</div>
			);
		};

		render(<View />);

		expect(screen.getByTestId("early").textContent).toBe("7");
		expect(renders).toBe(2);
		expect(queued).toHaveLength(0);
	});

	it("§6.2 a change to an unread key between render and subscription does not re-render", () => {
		const queued = new Array<() => void>();
		let renders = 0;

		const Mutator: FC<{ state: { count: number; other: number } }> = ({ state }) => {
			const mutated = useRef(false);

			useLayoutEffect(() => {
				if (mutated.current) return;

				mutated.current = true;
				state.other = 7;
			});

			return null;
		};

		const View: FC = () => {
			const state = useMutableState({ count: 0, other: 0 }, { emitOn: (flush) => queued.push(flush) });

			renders += 1;

			return (
				<div>
					<Mutator state={state} />
					<span data-testid="unread-gap">{state.count}</span>
				</div>
			);
		};

		render(<View />);

		expect(screen.getByTestId("unread-gap").textContent).toBe("0");
		expect(renders).toBe(1);
		expect(queued).toHaveLength(0);
	});

	it("rerenders for a write made while a source was departed", async () => {
		let heldA: { count: number } | undefined;
		let switchSource: ((value: "a" | "b") => void) | undefined;
		let renders = 0;

		const View: FC = () => {
			const stateA = useMutableState({ count: 0 });
			const stateB = useMutableState({ count: 0 });
			const [which, setWhich] = useState<"a" | "b">("a");
			const state = which === "a" ? stateA : stateB;

			switchSource = setWhich;
			heldA = stateA;
			renders += 1;

			return <span data-testid="count">{state.count}</span>;
		};

		render(<View />);
		expect(renders).toBe(1);
		expect(screen.getByTestId("count").textContent).toBe("0");

		await act(async () => {
			switchSource?.("b");
		});

		expect(renders).toBe(2);

		await act(async () => {
			if (heldA === undefined) throw new Error("missing state");

			heldA.count = 1;
		});

		expect(renders).toBe(2);

		await act(async () => {
			switchSource?.("a");
		});

		expect(screen.getByTestId("count").textContent).toBe("1");
		expect(renders).toBe(3);
	});
});
