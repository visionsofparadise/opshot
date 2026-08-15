import { createGroup } from "../createGroup";
import { createMutableState } from "../createMutableState";
import { handleOf } from "../handle";
import { diffObjects } from "../ops/diff";
import { type Operation } from "../ops/operation";
import { stampOptions } from "../settings";
import { subscribe } from "../subscribe";
import { transact } from "../transact/transact";
import { emitWrites, scheduleFlush } from "./emitter";
import { targetOf } from "./emitterRegistry";
import { shapeOps } from "../ops/operationShape";

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

describe("emitter", () => {
	it("scheduleFlush uses the handle emitOn when stamped root options are stale or absent", async () => {
		const stamped = manualScheduler();
		const bag = manualScheduler();
		const state = createMutableState({ count: 0 });
		const handle = handleOf(state);

		expect(handle).toBeDefined();

		handle!.emitOn = bag.emitOn;
		stampOptions(targetOf(handle!.proxy.root), { emitOn: stamped.emitOn });

		scheduleFlush(handle!);

		await Promise.resolve();

		expect(stamped.pending).toHaveLength(0);
		expect(bag.pending).toHaveLength(1);
	});

	it("emitWrites is a no-op when current equals lastSnapshot", async () => {
		const state = createMutableState({ count: 0 });
		const handle = handleOf(state);

		expect(handle).toBeDefined();

		vi.mocked(diffObjects).mockClear();

		emitWrites(handle!);
		scheduleFlush(handle!);

		await Promise.resolve();

		expect(diffObjects).not.toHaveBeenCalled();
	});

	it("a live freeze then a tracked write emits only the tracked field", async () => {
		const state = createMutableState({ child: { n: 1 }, count: 0 });
		const heard = new Array<ReadonlyArray<Operation>>();

		subscribe(state, (ops) => {
			heard.push([...ops]);
		});

		Object.freeze(state.child);
		state.count = 1;

		await Promise.resolve();

		expect(heard.map(shapeOps)).toEqual([
			[{ do: { verb: "assign", path: ["count"], value: 1 }, undo: { verb: "assign", path: ["count"], value: 0 } }],
		]);
	});

	it("flushes a bare cyclic formation as ordinary ops", async () => {
		const state = createMutableState<{ node: CyclicNode }>({ node: { n: 1 } });
		const heard = new Array<ReadonlyArray<Operation>>();

		state.node.self = state.node;

		subscribe(state, (ops) => {
			heard.push([...ops]);
		});

		state.node.n = 2;

		await Promise.resolve();

		expect(heard.length).toBeGreaterThan(0);
		expect(heard[0]?.[0]?.do.verb).toBe("assign");
		expect(state.node.self).toBe(state.node);
		expect(state.node.n).toBe(2);
	});
});

describe("emitOn window", () => {
	it("recaptures baseline on first state subscribe of an unlistened grouped record", async () => {
		const scheduler = manualScheduler();
		const group = createGroup();
		const state = group.createMutableState({ count: 0 }, { emitOn: scheduler.emitOn });
		const heard = new Array<ReadonlyArray<Operation>>();

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
		const groupHeard = new Array<ReadonlyArray<Operation>>();
		const stateHeard = new Array<ReadonlyArray<Operation>>();

		subscribe(group, (_emitted, ops) => {
			groupHeard.push([...ops]);
		});

		state.count = 1;

		await Promise.resolve();

		subscribe(state, (ops) => {
			stateHeard.push([...ops]);
		});

		scheduler.flushAll();

		expect(stateHeard.map(shapeOps)).toEqual([
			[{ do: { verb: "assign", path: ["count"], value: 1 }, undo: { verb: "assign", path: ["count"], value: 0 } }],
		]);
		expect(groupHeard.map(shapeOps)).toEqual(stateHeard.map(shapeOps));
	});

	it("group subscribe does not recapture an open window", async () => {
		const scheduler = manualScheduler();
		const group = createGroup();
		const state = group.createMutableState({ count: 0 }, { emitOn: scheduler.emitOn });
		const heard = new Array<ReadonlyArray<Operation>>();

		state.count = 1;

		await Promise.resolve();

		subscribe(group, (_emitted, ops) => {
			heard.push([...ops]);
		});

		scheduler.flushAll();

		expect(heard.map(shapeOps)).toEqual([
			[{ do: { verb: "assign", path: ["count"], value: 1 }, undo: { verb: "assign", path: ["count"], value: 0 } }],
		]);
	});

	it("N writes in one window schedule one callback and deliver one net-diff emission", async () => {
		const scheduler = manualScheduler();
		const state = createMutableState({ count: 0 }, { emitOn: scheduler.emitOn });
		const heard = new Array<ReadonlyArray<Operation>>();

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

		expect(heard.map(shapeOps)).toEqual([
			[{ do: { verb: "assign", path: ["count"], value: 3 }, undo: { verb: "assign", path: ["count"], value: 0 } }],
		]);
		expect(scheduler.pending).toHaveLength(0);
	});

	it("transact at entry settles pending bare writes; the scheduled callback then delivers nothing", async () => {
		const scheduler = manualScheduler();
		const state = createMutableState({ count: 0 }, { emitOn: scheduler.emitOn });
		const heard = new Array<{ ops: ReadonlyArray<Operation>; meta: unknown }>();

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

		expect(heard.map((entry) => ({ ops: shapeOps(entry.ops), meta: entry.meta }))).toEqual([
			{
				ops: [
					{
						do: { verb: "assign", path: ["count"], value: 1 },
						undo: { verb: "assign", path: ["count"], value: 0 },
					},
				],
				meta: undefined,
			},
			{
				ops: [
					{
						do: { verb: "assign", path: ["count"], value: 2 },
						undo: { verb: "assign", path: ["count"], value: 1 },
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
		const heard = new Array<{ ops: ReadonlyArray<Operation>; meta: unknown }>();

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

		heard.length = 0;
		scheduler.flushAll();

		expect(heard.map((entry) => ({ ops: shapeOps(entry.ops), meta: entry.meta }))).toEqual([
			{
				ops: [
					{
						do: { verb: "assign", path: ["count"], value: 3 },
						undo: { verb: "assign", path: ["count"], value: 2 },
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
		const heard = new Array<ReadonlyArray<Operation>>();

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

		expect(heard.map(shapeOps)).toEqual([
			[{ do: { verb: "assign", path: ["count"], value: 2 }, undo: { verb: "assign", path: ["count"], value: 1 } }],
		]);
	});

	it("the last unsubscribe delivers the pending write before returning", async () => {
		const scheduler = manualScheduler();
		const state = createMutableState({ count: 0 }, { emitOn: scheduler.emitOn });
		const heard = new Array<ReadonlyArray<Operation>>();
		const stop = subscribe(state, (ops) => {
			heard.push([...ops]);
		});

		state.count = 1;

		await Promise.resolve();

		expect(scheduler.pending).toHaveLength(1);
		expect(heard).toEqual([]);

		stop();

		expect(heard.map(shapeOps)).toEqual([
			[{ do: { verb: "assign", path: ["count"], value: 1 }, undo: { verb: "assign", path: ["count"], value: 0 } }],
		]);
	});

	it("a subtree subscribed under a windowed root runs on the root's emitOn", () => {
		const state = createMutableState({ a: { x: 0 } });

		expect(() => {
			subscribe(state.a, () => undefined);
		}).toThrow("opshot: subscribe requires a state");
	});

	it("a cycle formed by a bare write under custom emitOn flushes ops from the scheduler callback", async () => {
		const thrown = new Array<unknown>();
		const heard = new Array<ReadonlyArray<Operation>>();
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

		subscribe(state, (ops) => {
			heard.push([...ops]);
		});

		state.node.self = state.node;
		await Promise.resolve();
		await Promise.resolve();

		state.node.n = 2;
		await Promise.resolve();
		await Promise.resolve();

		expect(thrown).toHaveLength(0);
		expect(heard.length).toBeGreaterThan(0);
		expect(state.node.self).toBe(state.node);
		expect(state.node.n).toBe(2);
	});

	it("delivers a bare shared write per-route in both states' streams", async () => {
		const shared = { n: 1 };
		const stateA = createMutableState({ box: shared });
		const stateB = createMutableState({ box: shared });
		const heardA = new Array<ReadonlyArray<Operation>>();
		const heardB = new Array<ReadonlyArray<Operation>>();

		subscribe(stateA, (ops) => {
			heardA.push([...ops]);
		});
		subscribe(stateB, (ops) => {
			heardB.push([...ops]);
		});

		stateA.box.n = 5;

		expect(heardA).toEqual([]);
		expect(heardB).toEqual([]);
		expect(stateB.box.n).toBe(5);

		await Promise.resolve();

		const expected = [
			[
				{
					do: { verb: "assign", path: ["box", "n"], value: 5 },
					undo: { verb: "assign", path: ["box", "n"], value: 1 },
				},
			],
		];

		expect(heardA.map(shapeOps)).toEqual(expected);
		expect(heardB.map(shapeOps)).toEqual(expected);
	});
});
