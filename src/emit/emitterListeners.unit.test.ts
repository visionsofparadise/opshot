import { createGroup } from "../createGroup";
import { createMutableState } from "../createMutableState";
import { handleOf } from "../handle";
import { diffObjects } from "../ops/diff";
import { type Operation } from "../ops/operation";
import { subscribe } from "../subscribe";
import { transact } from "../transact/transact";
import { addStateListener, holdsBinding } from "./emitterListeners";
import { shapeOps } from "../ops/operationShape";

vi.mock(import("../ops/diff"), { spy: true });

describe("emitterListeners", () => {
	it("stays silent with no subscriber: no record, still diffs", () => {
		const state = createMutableState({ count: 0 });

		vi.mocked(diffObjects).mockClear();

		transact(state, () => {
			state.count = 1;
		});

		expect(handleOf(state)).toBeDefined();
		expect(diffObjects).toHaveBeenCalled();
		expect(state.count).toBe(1);
	});

	it("emits a transaction with meta", () => {
		const state = createMutableState({ count: 0 });
		const heard = new Array<{ ops: ReadonlyArray<Operation>; meta: unknown }>();
		const listener = (ops: ReadonlyArray<Operation>, meta: unknown): void => {
			heard.push({ ops, meta });
		};

		addStateListener(state, listener, undefined, listener);

		transact(
			state,
			() => {
				state.count = 1;
			},
			{ actor: "a" },
		);

		expect(heard).toHaveLength(1);
		expect(heard[0]?.meta).toEqual({ actor: "a" });
		expect(shapeOps(heard[0]?.ops ?? [])).toEqual([
			{ do: { verb: "assign", path: ["count"], value: 1 }, undo: { verb: "assign", path: ["count"], value: 0 } },
		]);
	});

	it("emits a bare flush with undefined meta", async () => {
		const state = createMutableState({ count: 0 });
		const heard = new Array<{ ops: ReadonlyArray<Operation>; meta: unknown }>();
		const listener = (ops: ReadonlyArray<Operation>, meta: unknown): void => {
			heard.push({ ops, meta });
		};

		addStateListener(state, listener, undefined, listener);

		state.count = 5;

		expect(heard).toHaveLength(0);

		await Promise.resolve();

		expect(heard).toHaveLength(1);
		expect(heard[0]?.meta).toBeUndefined();
		expect(shapeOps(heard[0]?.ops ?? [])).toEqual([
			{ do: { verb: "assign", path: ["count"], value: 5 }, undo: { verb: "assign", path: ["count"], value: 0 } },
		]);
	});

	it("orders bare → transact → bare across one tick", async () => {
		const state = createMutableState({ count: 0, flag: false, trail: 0 });
		const order = new Array<string>();
		const listener = (ops: ReadonlyArray<Operation>, meta: unknown): void => {
			const path = ops[0]?.do.path[0];

			order.push(`${String(path)}:${meta === undefined ? "bare" : "tx"}`);
		};

		addStateListener(state, listener, undefined, listener);

		state.count = 1;
		transact(
			state,
			() => {
				state.flag = true;
			},
			{ tag: "tx" },
		);
		state.trail = 1;

		expect(order).toEqual(["count:bare", "flag:tx"]);

		await Promise.resolve();

		expect(order).toEqual(["count:bare", "flag:tx", "trail:bare"]);
	});

	it("fires group listeners before own listeners", () => {
		const group = createGroup();
		const state = group.createMutableState({ count: 0 });
		const order = new Array<string>();
		const own = (): void => {
			order.push("own");
		};

		addStateListener(state, own, undefined, own);
		subscribe(group, () => {
			order.push("group");
		});

		transact(state, () => {
			state.count = 1;
		});

		expect(order).toEqual(["group", "own"]);
	});

	it("delivers causes before effects to a parent when a child listener writes re-entrantly", () => {
		const parent = createGroup();
		const child = createGroup(parent);
		const first = child.createMutableState({ count: 0 });
		const second = child.createMutableState({ count: 0 });
		const parentOrder = new Array<object>();

		subscribe(child, (state) => {
			if (state === first) {
				transact(second, () => {
					second.count = 1;
				});
			}
		});

		subscribe(parent, (state) => {
			parentOrder.push(state);
		});

		transact(first, () => {
			first.count = 1;
		});

		expect(parentOrder).toEqual([first, second]);
	});

	it("still delivers remaining inner listeners after outer unsubscribes one", () => {
		const parent = createGroup();
		const child = createGroup(parent);
		const state = child.createMutableState({ count: 0 });
		const order = new Array<string>();
		let unsubscribeInner: (() => void) | undefined;

		subscribe(parent, () => {
			order.push("parent");
			unsubscribeInner?.();
		});

		unsubscribeInner = subscribe(child, () => {
			order.push("inner-first");
		});

		subscribe(child, () => {
			order.push("inner-second");
		});

		transact(state, () => {
			state.count = 1;
		});

		expect(order).toEqual(["parent", "inner-first", "inner-second"]);
	});

	it("still delivers an own listener unsubscribed by a group listener during the same emission", () => {
		const group = createGroup();
		const state = group.createMutableState({ count: 0 });
		const order = new Array<string>();
		let unsubscribeOwn: (() => void) | undefined;

		subscribe(group, () => {
			order.push("group");
			unsubscribeOwn?.();
		});

		const own = (): void => {
			order.push("own");
		};

		unsubscribeOwn = addStateListener(state, own, undefined, own);

		transact(state, () => {
			state.count = 1;
		});

		expect(order).toEqual(["group", "own"]);
	});

	it("delivers an open window when an ancestor listener already makes the record listened", async () => {
		const pending = new Array<() => void>();
		const emitOn = (flush: () => void): void => {
			pending.push(flush);
		};
		const parent = createGroup();
		const child = createGroup(parent);
		const state = child.createMutableState({ count: 0 }, { emitOn });
		const stateHeard = new Array<ReadonlyArray<Operation>>();

		subscribe(parent, () => undefined);

		state.count = 1;

		await Promise.resolve();

		subscribe(state, (ops) => {
			stateHeard.push([...ops]);
		});

		for (const flush of pending.splice(0)) flush();

		expect(stateHeard.map(shapeOps)).toEqual([
			[{ do: { verb: "assign", path: ["count"], value: 1 }, undo: { verb: "assign", path: ["count"], value: 0 } }],
		]);
	});

	it("throws on nested transact of an unsubscribed state", () => {
		const state = createMutableState({ count: 0 });

		expect(() =>
			transact(state, () => {
				transact(state, () => {
					state.count = 2;
				});
			}),
		).toThrow(
			"opshot: transact cannot be nested; a transaction cannot contain another. Mutate inside the callback rather than transacting, run transactions in sequence, or call applyOperations at top level.",
		);
	});

	it("leaves a pending write on the window when unsubscribe returns", async () => {
		const state = createMutableState({ count: 0 });
		const firstHeard = new Array<ReadonlyArray<Operation>>();
		const firstListener = (ops: ReadonlyArray<Operation>): void => {
			firstHeard.push(ops);
		};
		const unsubscribe = addStateListener(state, firstListener, undefined, firstListener);

		state.count = 1;
		unsubscribe();
		await Promise.resolve();

		expect(firstHeard).toEqual([]);

		const secondHeard = new Array<ReadonlyArray<Operation>>();
		const secondListener = (ops: ReadonlyArray<Operation>): void => {
			secondHeard.push(ops);
		};

		addStateListener(state, secondListener, undefined, secondListener);

		state.count = 2;
		await Promise.resolve();

		expect(secondHeard.map(shapeOps)).toEqual([
			[{ do: { verb: "assign", path: ["count"], value: 2 }, undo: { verb: "assign", path: ["count"], value: 1 } }],
		]);
	});

	it("does not invoke listeners when a sibling unsubscribes with a pending Write", async () => {
		const state = createMutableState({ count: 0 });
		const order = new Array<string>();
		let unsubscribeSecond: (() => void) | undefined;
		const first = (): void => {
			order.push("first");
			unsubscribeSecond?.();
		};
		const second = (): void => {
			order.push("second");
		};

		const unsubscribeFirst = addStateListener(state, first, undefined, first);

		unsubscribeSecond = addStateListener(state, second, undefined, second);

		state.count = 1;

		expect(() => {
			unsubscribeFirst();
		}).not.toThrow();

		expect(order).toEqual([]);

		await Promise.resolve();

		expect(order).toEqual(["second"]);
	});

	it("does not settle on group unsubscription because a group retains none of its states", async () => {
		const group = createGroup();
		const state = group.createMutableState({ count: 0 });
		const groupHeard = new Array<ReadonlyArray<Operation>>();
		const ownHeard = new Array<ReadonlyArray<Operation>>();
		const own = (ops: ReadonlyArray<Operation>): void => {
			ownHeard.push(ops);
		};

		const unsubscribeGroup = subscribe(group, (_state, ops) => {
			groupHeard.push(ops);
		});

		addStateListener(state, own, undefined, own);

		state.count = 1;
		unsubscribeGroup();

		expect(groupHeard).toEqual([]);
		expect(ownHeard).toEqual([]);

		await Promise.resolve();

		expect(groupHeard).toEqual([]);
		expect(ownHeard.map(shapeOps)).toEqual([
			[{ do: { verb: "assign", path: ["count"], value: 1 }, undo: { verb: "assign", path: ["count"], value: 0 } }],
		]);
	});

	it("releases what a spent unsubscribe captured, and stays a no-op when called again", () => {
		const state = createMutableState({ count: 0 });
		const heard = new Array<Array<Operation>>();
		const stop = subscribe(state, (ops) => heard.push([...ops]));

		transact(state, () => {
			state.count = 1;
		});

		stop();
		stop();
		stop();

		transact(state, () => {
			state.count = 2;
		});

		expect(heard).toHaveLength(1);

		const resumed = new Array<Array<Operation>>();
		const again = subscribe(state, (ops) => resumed.push([...ops]));

		transact(state, () => {
			state.count = 3;
		});

		again();

		expect(resumed).toHaveLength(1);
	});

	it("releases the binding a spent unsubscribe held, on both the teardown and the already-gone path", () => {
		const state = createMutableState({ count: 0 });
		const listener = (): void => undefined;
		const first = subscribe(state, listener);
		const duplicate = subscribe(state, listener);

		expect(holdsBinding(first)).toBe(true);
		expect(holdsBinding(duplicate)).toBe(true);

		first();

		expect(holdsBinding(first)).toBe(false);
		expect(holdsBinding(duplicate)).toBe(true);

		duplicate();

		expect(holdsBinding(duplicate)).toBe(false);
	});

	it("releases a spent group unsubscribe's binding", () => {
		const group = createGroup();
		const stop = subscribe(group, () => undefined);

		expect(holdsBinding(stop)).toBe(true);

		stop();

		expect(holdsBinding(stop)).toBe(false);
	});
});
