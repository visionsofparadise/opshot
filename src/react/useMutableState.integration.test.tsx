// @vitest-environment jsdom

import { act, fireEvent, render, screen } from "@testing-library/react";
import type { FC } from "react";

import { transact } from "../transact/transact";
import { scope } from "./scope";
import { useMutableState } from "./useMutableState";

describe("useMutableState", () => {
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

	it("does not rerender when a transact of a read field rolls back", async () => {
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
});
