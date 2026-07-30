import { createGroup } from "../createGroup";
import { getGroupListeners } from "../createGroup";
import { createMutableState } from "../createMutableState";
import { diffSnapshots } from "../ops/diff";
import { type Op } from "../ops/operation";
import { subscribe } from "../subscribe";
import { transact } from "../transact";
import { emitBareFlush, mintGroupedEmitter } from "./emitterBare";
import { getOrCreateEmitter } from "./emitterRegistry";

type CyclicNode = { n: number; self?: CyclicNode };

vi.mock(import("../ops/diff"), { spy: true });

const manualScheduler = (): {
	pending: Array<() => void>;
	emitOn: (flush: () => void) => void;
	flushAll: () => void;
} => {
	const pending = new Array<() => void>();

	return {
		pending,
		emitOn: (flush) => {
			pending.push(flush);
		},
		flushAll: () => {
			const callbacks = pending.splice(0);

			for (const callback of callbacks) callback();
		},
	};
};

describe("emitterBare", () => {
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
			[{ do: { op: "assign", path: ["count"], value: 2 }, undo: { op: "assign", path: ["count"], value: 1 } }],
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

describe("emitOn window", () => {
	it("recaptures baseline on first state subscribe of an unlistened grouped record", async () => {
		const scheduler = manualScheduler();
		const group = createGroup();
		const state = group.createMutableState({ count: 0 }, { emitOn: scheduler.emitOn });
		const heard = new Array<ReadonlyArray<Op>>();

		state.count = 1;

		await Promise.resolve();

		subscribe(state, (ops) => {
			heard.push([...ops]);
		});

		scheduler.flushAll();

		expect(heard).toEqual([]);
		expect(state.count).toBe(1);
	});

	it("does not recapture when a group listener already makes the record listened", async () => {
		const scheduler = manualScheduler();
		const group = createGroup();
		const state = group.createMutableState({ count: 0 }, { emitOn: scheduler.emitOn });
		const groupHeard = new Array<ReadonlyArray<Op>>();
		const stateHeard = new Array<ReadonlyArray<Op>>();

		subscribe(group, (_emitted, ops) => {
			groupHeard.push([...ops]);
		});

		state.count = 1;

		await Promise.resolve();

		subscribe(state, (ops) => {
			stateHeard.push([...ops]);
		});

		scheduler.flushAll();

		expect(stateHeard).toEqual([
			[{ do: { op: "assign", path: ["count"], value: 1 }, undo: { op: "assign", path: ["count"], value: 0 } }],
		]);
		expect(groupHeard).toEqual(stateHeard);
	});

	it("group subscribe does not recapture an open window", async () => {
		const scheduler = manualScheduler();
		const group = createGroup();
		const state = group.createMutableState({ count: 0 }, { emitOn: scheduler.emitOn });
		const heard = new Array<ReadonlyArray<Op>>();

		state.count = 1;

		await Promise.resolve();

		subscribe(group, (_emitted, ops) => {
			heard.push([...ops]);
		});

		scheduler.flushAll();

		expect(heard).toEqual([
			[{ do: { op: "assign", path: ["count"], value: 1 }, undo: { op: "assign", path: ["count"], value: 0 } }],
		]);
	});

	it("N writes in one window schedule one callback and deliver one net-diff emission", async () => {
		const scheduler = manualScheduler();
		const state = createMutableState({ count: 0 }, { emitOn: scheduler.emitOn });
		const heard = new Array<ReadonlyArray<Op>>();

		subscribe(state, (ops) => {
			heard.push([...ops]);
		});

		state.count = 1;
		state.count = 2;
		state.count = 3;

		await Promise.resolve();

		expect(scheduler.pending).toHaveLength(1);
		expect(heard).toEqual([]);

		scheduler.flushAll();

		expect(heard).toEqual([
			[{ do: { op: "assign", path: ["count"], value: 3 }, undo: { op: "assign", path: ["count"], value: 0 } }],
		]);
		expect(scheduler.pending).toHaveLength(0);
	});

	it("transact at entry settles pending bare writes; the scheduled callback then delivers nothing", async () => {
		const scheduler = manualScheduler();
		const state = createMutableState({ count: 0 }, { emitOn: scheduler.emitOn });
		const heard = new Array<{ ops: ReadonlyArray<Op>; meta: unknown }>();

		subscribe(state, (ops, meta) => {
			heard.push({ ops: [...ops], meta });
		});

		state.count = 1;

		await Promise.resolve();

		expect(scheduler.pending).toHaveLength(1);

		transact(
			state,
			() => {
				state.count = 2;
			},
			{ tag: "txn" },
		);

		expect(heard).toEqual([
			{
				ops: [
					{
						do: { op: "assign", path: ["count"], value: 1 },
						undo: { op: "assign", path: ["count"], value: 0 },
					},
				],
				meta: undefined,
			},
			{
				ops: [
					{
						do: { op: "assign", path: ["count"], value: 2 },
						undo: { op: "assign", path: ["count"], value: 1 },
					},
				],
				meta: { tag: "txn" },
			},
		]);

		heard.length = 0;
		scheduler.flushAll();

		expect(heard).toEqual([]);
	});

	it("a write after a fence and before the callback is delivered by that callback", async () => {
		const scheduler = manualScheduler();
		const state = createMutableState({ count: 0 }, { emitOn: scheduler.emitOn });
		const heard = new Array<{ ops: ReadonlyArray<Op>; meta: unknown }>();

		subscribe(state, (ops, meta) => {
			heard.push({ ops: [...ops], meta });
		});

		state.count = 1;

		await Promise.resolve();

		transact(
			state,
			() => {
				state.count = 2;
			},
			{ tag: "txn" },
		);

		state.count = 3;

		await Promise.resolve();

		expect(scheduler.pending).toHaveLength(1);

		heard.length = 0;
		scheduler.flushAll();

		expect(heard).toEqual([
			{
				ops: [
					{
						do: { op: "assign", path: ["count"], value: 3 },
						undo: { op: "assign", path: ["count"], value: 2 },
					},
				],
				meta: undefined,
			},
		]);
		expect(scheduler.pending).toHaveLength(0);
	});

	it("a write after the callback opens a new window", async () => {
		const scheduler = manualScheduler();
		const state = createMutableState({ count: 0 }, { emitOn: scheduler.emitOn });
		const heard = new Array<ReadonlyArray<Op>>();

		subscribe(state, (ops) => {
			heard.push([...ops]);
		});

		state.count = 1;

		await Promise.resolve();
		scheduler.flushAll();

		expect(heard).toHaveLength(1);

		heard.length = 0;
		state.count = 2;

		await Promise.resolve();

		expect(scheduler.pending).toHaveLength(1);

		scheduler.flushAll();

		expect(heard).toEqual([
			[{ do: { op: "assign", path: ["count"], value: 2 }, undo: { op: "assign", path: ["count"], value: 1 } }],
		]);
	});

	it("the last unsubscribe delivers the pending write before returning", async () => {
		const scheduler = manualScheduler();
		const state = createMutableState({ count: 0 }, { emitOn: scheduler.emitOn });
		const heard = new Array<ReadonlyArray<Op>>();
		const stop = subscribe(state, (ops) => {
			heard.push([...ops]);
		});

		state.count = 1;

		await Promise.resolve();

		expect(scheduler.pending).toHaveLength(1);
		expect(heard).toEqual([]);

		stop();

		expect(heard).toEqual([
			[{ do: { op: "assign", path: ["count"], value: 1 }, undo: { op: "assign", path: ["count"], value: 0 } }],
		]);
	});

	it("a subtree subscribed under a windowed root runs on the root's emitOn", async () => {
		const scheduler = manualScheduler();
		const state = createMutableState({ a: { x: 0 } }, { emitOn: scheduler.emitOn });
		const heard = new Array<ReadonlyArray<Op>>();

		subscribe(state.a, (ops) => {
			heard.push([...ops]);
		});

		state.a.x = 1;

		await Promise.resolve();

		expect(scheduler.pending).toHaveLength(1);
		expect(heard).toEqual([]);

		scheduler.flushAll();

		expect(heard).toEqual([
			[{ do: { op: "assign", path: ["x"], value: 1 }, undo: { op: "assign", path: ["x"], value: 0 } }],
		]);
	});

	it("a cycle formed by a bare write under custom emitOn throws from the scheduler callback", async () => {
		const thrown = new Array<unknown>();
		const emitOn = (flush: () => void): void => {
			queueMicrotask(() => {
				try {
					flush();
				} catch (error) {
					thrown.push(error);
				}
			});
		};
		const state = createMutableState<{ node: CyclicNode }>({ node: { n: 1 } }, { emitOn });

		subscribe(state, () => undefined);

		state.node.self = state.node;
		await Promise.resolve();
		await Promise.resolve();

		state.node.n = 2;
		await Promise.resolve();
		await Promise.resolve();

		expect(thrown.length).toBeGreaterThan(0);
		expect(String(thrown[0])).toMatch(/transact/);
	});
});
