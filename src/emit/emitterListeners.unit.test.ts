import { createGroup } from "../createGroup";
import { createMutableState } from "../createMutableState";
import { diffSnapshots } from "../ops/diff";
import { type Op } from "../ops/operation";
import { subscribe } from "../subscribe";
import { transact } from "../transact";
import { emitBareFlush } from "./emitterBare";
import { getEmitter } from "./emitterRegistry";
import { addStateListener } from "./emitterListeners";

vi.mock(import("../ops/diff"), { spy: true });

describe("emitterListeners", () => {
	it("stays silent with no subscriber: no record, no diff", () => {
		const state = createMutableState({ count: 0 });

		vi.mocked(diffSnapshots).mockClear();

		transact(state, () => {
			state.count = 1;
		});

		expect(getEmitter(state)).toBeUndefined();
		expect(diffSnapshots).not.toHaveBeenCalled();
		expect(state.count).toBe(1);
	});

	it("emits a transaction with meta", () => {
		const state = createMutableState({ count: 0 });
		const heard = new Array<{ ops: ReadonlyArray<Op>; meta: unknown }>();
		const listener = (ops: ReadonlyArray<Op>, meta: unknown): void => {
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
		expect(heard[0]?.ops).toEqual([
			{ do: { op: "replace", path: ["count"], value: 1 }, undo: { op: "replace", path: ["count"], value: 0 } },
		]);
	});

	it("emits a bare flush with undefined meta", async () => {
		const state = createMutableState({ count: 0 });
		const heard = new Array<{ ops: ReadonlyArray<Op>; meta: unknown }>();
		const listener = (ops: ReadonlyArray<Op>, meta: unknown): void => {
			heard.push({ ops, meta });
		};

		addStateListener(state, listener, undefined, listener);

		state.count = 5;

		expect(heard).toHaveLength(0);

		await Promise.resolve();

		expect(heard).toHaveLength(1);
		expect(heard[0]?.meta).toBeUndefined();
		expect(heard[0]?.ops).toEqual([
			{ do: { op: "replace", path: ["count"], value: 5 }, undo: { op: "replace", path: ["count"], value: 0 } },
		]);
	});

	it("orders bare → transact → bare across one tick", async () => {
		const state = createMutableState({ count: 0, flag: false, trail: 0 });
		const order = new Array<string>();
		const listener = (ops: ReadonlyArray<Op>, meta: unknown): void => {
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

	it("throws on nested transact of the same state", () => {
		const state = createMutableState({ count: 0 });
		const listener = (): undefined => undefined;

		addStateListener(state, listener, undefined, listener);

		expect(() =>
			transact(state, () => {
				transact(state, () => {
					state.count = 2;
				});
			}),
		).toThrow("opshot: nested transact on the same state");
	});

	it("delivers a bare write pending at teardown before unsubscribe returns", () => {
		const state = createMutableState({ count: 0 });
		const firstHeard = new Array<ReadonlyArray<Op>>();
		const firstListener = (ops: ReadonlyArray<Op>): void => {
			firstHeard.push(ops);
		};
		const unsubscribe = addStateListener(state, firstListener, undefined, firstListener);

		state.count = 1;
		unsubscribe();

		expect(firstHeard).toEqual([
			[{ do: { op: "replace", path: ["count"], value: 1 }, undo: { op: "replace", path: ["count"], value: 0 } }],
		]);

		const secondHeard = new Array<ReadonlyArray<Op>>();
		const secondListener = (ops: ReadonlyArray<Op>): void => {
			secondHeard.push(ops);
		};

		addStateListener(state, secondListener, undefined, secondListener);

		state.count = 2;
		emitBareFlush(state);

		expect(secondHeard).toEqual([
			[{ do: { op: "replace", path: ["count"], value: 2 }, undo: { op: "replace", path: ["count"], value: 1 } }],
		]);
	});

	it("survives a listener unsubscribing a sibling during settle at teardown", () => {
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

		expect(order).toEqual(["first", "second"]);
	});

	it("does not settle on group unsubscription because a group retains none of its states", async () => {
		const group = createGroup();
		const state = group.createMutableState({ count: 0 });
		const groupHeard = new Array<ReadonlyArray<Op>>();
		const ownHeard = new Array<ReadonlyArray<Op>>();
		const own = (ops: ReadonlyArray<Op>): void => {
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
		expect(ownHeard).toEqual([
			[{ do: { op: "replace", path: ["count"], value: 1 }, undo: { op: "replace", path: ["count"], value: 0 } }],
		]);
	});
});
