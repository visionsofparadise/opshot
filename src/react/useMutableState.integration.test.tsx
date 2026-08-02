// @vitest-environment jsdom

import { act, fireEvent, render, screen } from "@testing-library/react";
import { useEffect, useLayoutEffect, useRef, useState, type FC } from "react";

import { createMutableState } from "../createMutableState";
import { identify, isSameIdentity } from "../identity";
import { subscribe } from "../subscribe";
import { transact } from "../transact";
import { isWrapper } from "./boundary";
import { scope } from "./scope";
import { useMutableState } from "./useMutableState";
import type { Op } from "../ops/operation";

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

	it("runs a function initializer once across renders and keeps one state", () => {
		let initializations = 0;
		let bump: (() => void) | undefined;
		const identities = new Set<object>();

		const Counter: FC = () => {
			const state = useMutableState(() => {
				initializations += 1;

				return { count: 0 };
			});
			const [, force] = useState(0);

			bump = () => {
				force((value) => value + 1);
			};
			identities.add(identify(state));

			return <span>{state.count}</span>;
		};

		render(<Counter />);

		for (let index = 0; index < 2; index += 1) {
			act(() => {
				bump?.();
			});
		}

		expect(initializations).toBe(1);
		expect(identities.size).toBe(1);
	});

	it("evaluates a properties argument every render while keeping one state", () => {
		let evaluations = 0;
		let bump: (() => void) | undefined;
		const identities = new Set<object>();

		const build = (): { count: number } => {
			evaluations += 1;

			return { count: 0 };
		};

		const Counter: FC = () => {
			const state = useMutableState(build());
			const [, force] = useState(0);

			bump = () => {
				force((value) => value + 1);
			};
			identities.add(identify(state));

			return <span>{state.count}</span>;
		};

		render(<Counter />);

		for (let index = 0; index < 2; index += 1) {
			act(() => {
				bump?.();
			});
		}

		expect(evaluations).toBe(3);
		expect(identities.size).toBe(1);
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

	it("handler reads do not subscribe the component", () => {
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

		act(() => {
			if (stateRef === undefined) throw new Error("missing state");

			stateRef.extra += 1;
		});

		expect(renders).toBe(1);

		act(() => {
			if (stateRef === undefined) throw new Error("missing state");

			stateRef.count += 1;
		});

		expect(renders).toBe(2);
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

	it("keeps a non-reading owner silent for a nested write after render", () => {
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

		expect(renders).toBe(1);
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

	it("delivers a write to the subscription the same write tears down", async () => {
		const heard = new Array<ReadonlyArray<Op>>();

		const View: FC = () => {
			const state = useMutableState({ count: 0 });

			useEffect(
				() =>
					subscribe(state, (ops) => {
						heard.push(ops);
					}),
				[state],
			);

			return (
				<button
					type="button"
					onClick={() => {
						state.count += 1;
					}}
				>
					{state.count}
				</button>
			);
		};

		render(<View />);

		await act(async () => {
			fireEvent.click(screen.getByRole("button"));
		});

		expect(heard).toEqual([
			[{ do: { op: "assign", path: ["count"], value: 1 }, undo: { op: "assign", path: ["count"], value: 0 } }],
		]);

		await act(async () => {
			fireEvent.click(screen.getByRole("button"));
		});

		expect(heard).toEqual([
			[{ do: { op: "assign", path: ["count"], value: 1 }, undo: { op: "assign", path: ["count"], value: 0 } }],
			[{ do: { op: "assign", path: ["count"], value: 2 }, undo: { op: "assign", path: ["count"], value: 1 } }],
		]);
		expect(screen.getByRole("button").textContent).toBe("2");
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

	it("idiomatic debounce keyed on the handle produces one save after a burst, matching useState", async () => {
		const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

		const stateSaves: Array<string> = [];
		let held: { draft: string } | undefined;

		const StateEditor: FC = () => {
			const state = useMutableState({ draft: "" });

			held = state;

			useEffect(() => {
				const timer = setTimeout(() => {
					stateSaves.push(state.draft);
				}, 30);

				return () => {
					clearTimeout(timer);
				};
			}, [state]);

			return <span>{state.draft}</span>;
		};

		render(<StateEditor />);

		for (const character of "hello") {
			await act(async () => {
				if (held === undefined) throw new Error("missing state");

				held.draft += character;
			});
		}

		await act(async () => {
			await wait(80);
		});

		const controlSaves: Array<string> = [];
		let type: ((character: string) => void) | undefined;

		const ControlEditor: FC = () => {
			const [draft, setDraft] = useState("");

			type = (character: string) => {
				setDraft(draft + character);
			};

			useEffect(() => {
				const timer = setTimeout(() => {
					controlSaves.push(draft);
				}, 30);

				return () => {
					clearTimeout(timer);
				};
			}, [draft]);

			return <span>{draft}</span>;
		};

		render(<ControlEditor />);

		for (const character of "hello") {
			await act(async () => {
				type?.(character);
			});
		}

		await act(async () => {
			await wait(80);
		});

		expect(stateSaves).toEqual(["hello"]);
		expect(controlSaves).toEqual(["hello"]);
	});

	it("resolves a handle assigned into another state to its live proxy", () => {
		interface Held {
			nested: { n: number };
		}

		const holder = createMutableState<{ current?: Held }>({});
		const heard = new Array<Array<string>>();

		subscribe(holder, (ops) => heard.push(ops.map((op) => op.do.path.join("/"))));

		let handle: Held | undefined;

		const Child = scope<{ state: Held }>(({ state }) => {
			handle = state;

			return <span>{state.nested.n}</span>;
		});

		const Parent: FC = () => {
			const state = useMutableState<Held>(() => ({ nested: { n: 0 } }));

			return <Child state={state} />;
		};

		render(<Parent />);

		if (handle === undefined) throw new Error("missing handle");

		const assigned = handle;

		act(() => {
			transact(holder, () => {
				holder.current = assigned;
			});
		});

		expect(heard).toEqual([["current"]]);
		expect(isWrapper(holder.current)).toBe(false);
		expect(isSameIdentity(holder.current as object, assigned)).toBe(true);

		act(() => {
			transact(holder, () => {
				assigned.nested.n = 5;
			});
		});

		expect(heard).toEqual([["current"], ["current/nested/n"]]);
		expect(holder.current?.nested.n).toBe(5);
	});

	it("assigns a handle carrying an array into another state", () => {
		interface Held {
			items: Array<number>;
		}

		const holder = createMutableState<{ current?: Held }>({});
		const heard = new Array<Array<string>>();

		subscribe(holder, (ops) => heard.push(ops.map((op) => op.do.path.join("/"))));

		let handle: Held | undefined;

		const Child = scope<{ state: Held }>(({ state }) => {
			handle = state;

			return <span>{state.items.length}</span>;
		});

		const Parent: FC = () => {
			const state = useMutableState<Held>(() => ({ items: [1, 2, 3] }));

			return <Child state={state} />;
		};

		render(<Parent />);

		if (handle === undefined) throw new Error("missing handle");

		const assigned = handle;

		act(() => {
			transact(holder, () => {
				holder.current = assigned;
			});
		});

		expect(heard).toEqual([["current"]]);
		expect(Array.isArray(holder.current?.items)).toBe(true);

		act(() => {
			transact(holder, () => {
				assigned.items.push(4);
			});
		});

		expect(holder.current?.items).toEqual([1, 2, 3, 4]);
		expect(heard).toHaveLength(2);
	});
});
