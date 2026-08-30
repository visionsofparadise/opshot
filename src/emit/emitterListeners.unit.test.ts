import { createGroup, getGroupListeners } from "../createGroup";
import { createMutableState } from "../createMutableState";
import { type Operation } from "../ops/operation";
import { batch } from "../batch";
import { addGroupListener, addStateListener } from "./emitterListeners";
import { shapeOps } from "../ops/operationShape";

describe("emitterListeners", () => {
	it("emits a batch with meta", () => {
		const state = createMutableState({ count: 0 });
		const heard = new Array<{ ops: ReadonlyArray<Operation>; meta: unknown }>();
		const listener = (ops: ReadonlyArray<Operation>, meta: unknown): void => {
			heard.push({ ops, meta });
		};

		addStateListener(state, listener, listener);

		batch(
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

		addStateListener(state, listener, listener);

		state.count = 5;

		expect(heard).toHaveLength(0);

		await Promise.resolve();

		expect(heard).toHaveLength(1);
		expect(heard[0]?.meta).toBeUndefined();
		expect(shapeOps(heard[0]?.ops ?? [])).toEqual([
			{ do: { verb: "assign", path: ["count"], value: 5 }, undo: { verb: "assign", path: ["count"], value: 0 } },
		]);
	});

	it("orders bare → batch → bare across one tick", async () => {
		const state = createMutableState({ count: 0, flag: false, trail: 0 });
		const order = new Array<string>();
		const listener = (ops: ReadonlyArray<Operation>, meta: unknown): void => {
			const path = ops[0]?.do.path[0];

			order.push(`${String(path)}:${meta === undefined ? "bare" : "tx"}`);
		};

		addStateListener(state, listener, listener);

		state.count = 1;
		batch(
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

	it("calling an unsubscribe a second time is a no-op for a state and for a group", () => {
		const state = createMutableState({ count: 0 });
		const stateHeard = new Array<number>();
		const stateListener = (ops: ReadonlyArray<Operation>): void => {
			stateHeard.push(ops.length);
		};
		const stopState = addStateListener(state, stateListener, stateListener);

		batch(() => {
			state.count = 1;
		});
		stopState();
		expect(() => {
			stopState();
		}).not.toThrow();
		batch(() => {
			state.count = 2;
		});

		expect(stateHeard).toHaveLength(1);

		const group = createGroup();
		const grouped = group.createMutableState({ count: 0 });
		const groupHeard = new Array<number>();
		const groupListener = (_emitted: object, ops: ReadonlyArray<Operation>): void => {
			groupHeard.push(ops.length);
		};
		const stopGroup = addGroupListener(getGroupListeners(group), groupListener, groupListener);

		batch(() => {
			grouped.count = 1;
		});
		stopGroup();
		expect(() => {
			stopGroup();
		}).not.toThrow();
		batch(() => {
			grouped.count = 2;
		});

		expect(groupHeard).toHaveLength(1);
	});

	it("the second unsubscribe of a duplicated listener pair releases only its binding", () => {
		const state = createMutableState({ count: 0 });
		const heard = new Array<string>();
		const pairListener = (): void => undefined;
		const pairDeliver = (): void => {
			heard.push("pair");
		};
		const first = addStateListener(state, pairListener, pairDeliver);
		const second = addStateListener(state, pairListener, pairDeliver);
		const otherListener = (): void => undefined;
		const otherDeliver = (): void => {
			heard.push("other");
		};

		addStateListener(state, otherListener, otherDeliver);

		batch(() => {
			state.count = 1;
		});

		expect(heard).toEqual(["pair", "other"]);

		heard.length = 0;
		first();

		batch(() => {
			state.count = 2;
		});

		expect(heard).toEqual(["other"]);

		heard.length = 0;
		expect(() => {
			second();
		}).not.toThrow();

		batch(() => {
			state.count = 3;
		});

		expect(heard).toEqual(["other"]);
	});
});
