import { createMutableState } from "../createMutableState";
import { type Operation } from "../ops/operation";
import { transact } from "../transact/transact";
import { addStateListener } from "./emitterListeners";
import { shapeOps } from "../ops/operationShape";

describe("emitterListeners", () => {
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
});
