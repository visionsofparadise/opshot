import { createMutableState } from "../createMutableState";
import { OccupancyRefusalError } from "../occupancy";
import { type Operation } from "../ops/operation";
import { shapeOps } from "../ops/operationShape";
import { subscribe } from "../subscribe";
import { transact } from "../transact/transact";

type CyclicNode = { n: number; self?: CyclicNode };

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

const tickAssign = (from: number, to: number) => [
	{
		do: { verb: "assign" as const, path: ["tick"], value: to },
		undo: { verb: "assign" as const, path: ["tick"], value: from },
	},
];

describe("write-window occupancy refusal", () => {
	it("a bare write producing one dangerous occupancy throws the refusal out of the flush after sibling ops", async () => {
		const scheduler = manualScheduler();
		const state = createMutableState({ box: null as unknown, tick: 0 }, { emitOn: scheduler.emitOn });
		const heard = new Array<ReadonlyArray<Operation>>();

		subscribe(state, (ops) => {
			heard.push([...ops]);
		});

		state.box = new Map<string, number>();
		state.tick = 1;

		await Promise.resolve();

		expect(heard).toEqual([]);

		let refusal: unknown;

		try {
			scheduler.flushAll();
		} catch (error) {
			refusal = error;
		}

		expect(refusal).toBeInstanceOf(OccupancyRefusalError);
		expect((refusal as OccupancyRefusalError).message).toContain("Map at /box");
		expect(heard.map(shapeOps)).toEqual([tickAssign(0, 1)]);
	});

	it("a configured onError receives the refusal and nothing throws", async () => {
		const errors = new Array<unknown>();
		const state = createMutableState(
			{ box: null as unknown, tick: 0 },
			{
				onError: (error) => {
					errors.push(error);
				},
			},
		);
		const heard = new Array<ReadonlyArray<Operation>>();

		subscribe(state, (ops) => {
			heard.push([...ops]);
		});

		state.box = new Map<string, number>();
		state.tick = 1;

		await Promise.resolve();

		expect(errors[0]).toBeInstanceOf(OccupancyRefusalError);
		expect((errors[0] as Error).message).toContain("Map at /box");
		expect(heard.map(shapeOps)).toEqual([tickAssign(0, 1)]);
	});

	it("two dangerous occupancies in one window raise one OccupancyRefusalError whose cause is the AggregateError", async () => {
		const scheduler = manualScheduler();
		const state = createMutableState(
			{ left: null as unknown, right: null as unknown, tick: 0 },
			{ emitOn: scheduler.emitOn },
		);
		const heard = new Array<ReadonlyArray<Operation>>();

		subscribe(state, (ops) => {
			heard.push([...ops]);
		});

		state.left = new Map<string, number>();
		state.right = new Set<number>();
		state.tick = 1;

		await Promise.resolve();

		let refusal: unknown;

		try {
			scheduler.flushAll();
		} catch (error) {
			refusal = error;
		}

		expect(refusal).toBeInstanceOf(OccupancyRefusalError);
		expect((refusal as OccupancyRefusalError).cause).toBeInstanceOf(AggregateError);
		expect(((refusal as OccupancyRefusalError).cause as AggregateError).errors).toHaveLength(2);
		expect(heard.map(shapeOps)).toEqual([tickAssign(0, 1)]);
	});

	it("a refused bare write commits the overlay so the next window diffs from the post-refusal snapshot", async () => {
		const errors = new Array<unknown>();
		const state = createMutableState(
			{ box: null as unknown, tick: 0 },
			{
				onError: (error) => {
					errors.push(error);
				},
			},
		);
		const heard = new Array<ReadonlyArray<Operation>>();

		subscribe(state, (ops) => {
			heard.push([...ops]);
		});

		state.box = new Map<string, number>();
		state.tick = 1;

		await Promise.resolve();

		expect(errors).toHaveLength(1);
		expect(heard.map(shapeOps)).toEqual([tickAssign(0, 1)]);

		heard.length = 0;
		state.tick = 2;

		await Promise.resolve();

		expect(errors).toHaveLength(1);
		expect(heard.map(shapeOps)).toEqual([tickAssign(1, 2)]);
	});
});
