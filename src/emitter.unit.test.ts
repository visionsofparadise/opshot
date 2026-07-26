import { createGroup } from "./createGroup";
import { createMutableState } from "./createMutableState";
import { addStateListener, emitBareFlush, getEmitter, getOrCreateEmitter, mintGroupedEmitter } from "./emitter";
import { getGroupListeners } from "./createGroup";
import { diffSnapshots } from "./ops/diff";
import { type Op } from "./ops/operation";
import { subscribe } from "./subscribe";
import { transact } from "./transact";

type CyclicNode = { n: number; self?: CyclicNode };

vi.mock(import("./ops/diff"), { spy: true });

describe("emitter", () => {
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

		addStateListener(state, (ops, meta) => {
			heard.push({ ops, meta });
		});

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

		addStateListener(state, (ops, meta) => {
			heard.push({ ops, meta });
		});

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

		addStateListener(state, (ops, meta) => {
			const path = ops[0]?.do.path[0];

			order.push(`${String(path)}:${meta === undefined ? "bare" : "tx"}`);
		});

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
		const state = group.createState({ count: 0 });
		const order = new Array<string>();

		addStateListener(state, () => {
			order.push("own");
		});
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

		addStateListener(state, () => undefined);

		expect(() =>
			transact(state, () => {
				transact(state, () => {
					state.count = 2;
				});
			}),
		).toThrow("opshot: nested transact on the same state");
	});

	it("mintGroupedEmitter arms at mint and stays quiescent without listeners", async () => {
		const group = createGroup();
		const listeners = getGroupListeners(group);
		const state = createMutableState({ count: 0 });
		const record = mintGroupedEmitter(state, listeners);

		expect(record.disarm).toBeTypeOf("function");

		vi.mocked(diffSnapshots).mockClear();

		state.count = 1;

		await Promise.resolve();

		expect(diffSnapshots).not.toHaveBeenCalled();
		expect(state.count).toBe(1);

		const heard = new Array<ReadonlyArray<Op>>();

		subscribe(group, (_state, ops) => {
			heard.push(ops);
		});

		state.count = 2;

		await Promise.resolve();

		expect(heard).toEqual([
			[{ do: { op: "replace", path: ["count"], value: 2 }, undo: { op: "replace", path: ["count"], value: 1 } }],
		]);
	});

	it("emitBareFlush is a no-op when current equals lastReported", () => {
		const state = createMutableState({ count: 0 });
		const record = getOrCreateEmitter(state);

		vi.mocked(diffSnapshots).mockClear();

		emitBareFlush(record.target);

		expect(diffSnapshots).not.toHaveBeenCalled();
	});

	it("augments a bare-flush cycle error naming transact as the catchable lane", async () => {
		const state = createMutableState<{ node: CyclicNode }>({ node: { n: 1 } });

		subscribe(state, () => undefined);

		state.node.self = state.node;
		await Promise.resolve();
		await Promise.resolve();

		state.node.n = 2;

		expect(() => {
			emitBareFlush(state);
		}).toThrow(/transact/);

		await Promise.resolve();
		await Promise.resolve();
	});
});
