import { snapshot } from "valtio/vanilla";

import { createMutableState } from "../createMutableState";
import { handleOf } from "../handle";
import { ignore } from "../ignore";
import { applyOperations } from "../ops/applyOperations";
import { type Operation } from "../ops/operation";
import { shapeOps } from "../ops/operationShape";
import { subscribe } from "../subscribe";
import { batch } from "../batch";

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

describe("freeze and untracked interiors", () => {
	it("a tracked flushed node frozen through the proxy emits nothing for it, and a later write beside it emits only that write", async () => {
		const state = createMutableState({ child: { n: 1 }, count: 0 });
		const heard = new Array<ReadonlyArray<Operation>>();

		subscribe(state, (ops) => {
			heard.push([...ops]);
		});

		state.count = 1;
		await Promise.resolve();
		heard.length = 0;

		const handle = handleOf(state);
		const lastSnapshot = handle?.lastSnapshot as { child: object } | undefined;

		expect(handle).toBeDefined();
		expect(lastSnapshot?.child).not.toBe(state.child);

		Object.freeze(state.child);
		await Promise.resolve();

		expect(heard).toEqual([]);

		state.count = 2;
		await Promise.resolve();

		expect(heard.map(shapeOps)).toEqual([
			[{ do: { verb: "assign", path: ["count"], value: 2 }, undo: { verb: "assign", path: ["count"], value: 1 } }],
		]);
	});

	it("mutation inside an ignore()-marked node's interior never emits", async () => {
		const hid = { n: 1, inner: { x: 1 } };
		const state = createMutableState({ hid: ignore(hid), tick: 0 });
		const heard = new Array<ReadonlyArray<Operation>>();

		subscribe(state, (ops) => {
			heard.push([...ops]);
		});

		hid.n = 2;
		hid.inner.x = 3;
		state.hid.n = 4;
		state.tick = 1;
		await Promise.resolve();

		expect(hid.n).toBe(4);
		expect(hid.inner.x).toBe(3);
		expect(heard.map(shapeOps)).toEqual([
			[{ do: { verb: "assign", path: ["tick"], value: 1 }, undo: { verb: "assign", path: ["tick"], value: 0 } }],
		]);
	});

	it("a frozen node's slot reassigned to a fresh value emits the assignment", async () => {
		const state = createMutableState({ box: { n: 1 } as { n: number } });
		const heard = new Array<ReadonlyArray<Operation>>();

		subscribe(state, (ops) => {
			heard.push([...ops]);
		});

		Object.freeze(state.box);
		state.box = { n: 2 };
		await Promise.resolve();

		expect(heard).toHaveLength(1);
		expect(heard[0]).toHaveLength(1);
		expect(heard[0]?.[0]?.do).toMatchObject({ verb: "assign", path: ["box"], value: { n: 2 } });
		expect(heard[0]?.[0]?.undo).toMatchObject({ verb: "assign", path: ["box"], value: { n: 1 } });
	});
});

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

	it("a refused batch's mints do not desync a later alias on a replica", () => {
		const origin = createMutableState<{
			tick: number;
			node?: { n: number };
			alias?: { n: number };
			bag?: { fresh: { n: number }; map: Map<string, number> };
		}>({ tick: 0 }, { strict: true });
		const heard = new Array<Array<Operation>>();

		subscribe(origin, (ops) => heard.push([...ops]));

		expect(() => {
			batch(() => {
				origin.bag = { fresh: { n: 2 }, map: new Map() };
			});
		}).toThrow("Map at /bag/map cannot be tracked");

		batch(() => {
			origin.node = { n: 1 };
		});

		batch(() => {
			origin.alias = origin.node;
		});

		expect(heard).toHaveLength(2);

		const replica = createMutableState<{
			tick: number;
			node?: { n: number };
			alias?: { n: number };
			bag?: { fresh: { n: number }; map: Map<string, number> };
		}>({ tick: 0 }, { strict: true });

		applyOperations(replica, JSON.parse(JSON.stringify(heard[0])) as Array<Operation>, "do");
		applyOperations(replica, JSON.parse(JSON.stringify(heard[1])) as Array<Operation>, "do");

		expect(replica.alias).toBe(replica.node);
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

	it("a batch write settles pending bare writes; the scheduled callback then delivers nothing", async () => {
		const scheduler = manualScheduler();
		const state = createMutableState({ count: 0 }, { emitOn: scheduler.emitOn });
		const heard = new Array<{ ops: ReadonlyArray<Operation>; meta: unknown }>();

		subscribe(state, (ops, meta) => {
			heard.push({ ops: [...ops], meta });
		});

		state.count = 1;

		await Promise.resolve();

		expect(scheduler.pending).toHaveLength(1);

		batch(
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

describe("write-window classification", () => {
	it("a raw-target write of dangerous material is user-owned: no throw, the window emits the tracked sibling, and a replica agrees with the stream", async () => {
		const state = createMutableState(
			{ x: null as { a: number; bad?: Map<string, number> } | null, tick: 0 },
			{ strict: true },
		);
		const heard = new Array<ReadonlyArray<Operation>>();

		subscribe(state, (ops) => {
			heard.push([...ops]);
		});

		const heldRaw: { a: number; bad?: Map<string, number> } = { a: 1 };

		state.x = heldRaw;

		await Promise.resolve();

		heldRaw.bad = new Map();
		state.tick = 1;

		await Promise.resolve();

		expect(heard.map((ops) => ops.map((operation) => operation.do.path))).toEqual([[["x"]], [["tick"]]]);

		const replica = createMutableState(
			{ x: null as { a: number; bad?: Map<string, number> } | null, tick: 0 },
			{ strict: true },
		);

		for (const ops of heard) applyOperations(replica, JSON.parse(JSON.stringify(ops)) as Array<Operation>, "do");

		expect(replica.tick).toBe(1);
		expect(replica.x?.a).toBe(1);
		expect(Object.hasOwn(replica.x as object, "bad")).toBe(false);
	});

	it("a defineProperty occupancy is an untracked edge: the window emits the tracked sibling, nothing raises, and a replica converges with the stream", async () => {
		const state = createMutableState<{ box: { a: number; meta?: object }; tick: number }>(
			{ box: { a: 1 }, tick: 0 },
			{ strict: true },
		);
		const heard = new Array<ReadonlyArray<Operation>>();

		subscribe(state, (ops) => {
			heard.push([...ops]);
		});

		Object.defineProperty(state.box, "meta", { value: { x: 1 }, enumerable: true });
		state.box.a = 2;

		await Promise.resolve();

		expect(heard.map((ops) => ops.map((operation) => operation.do.path))).toEqual([[["box", "a"]]]);

		const replica = createMutableState<{ box: { a: number; meta?: object }; tick: number }>(
			{ box: { a: 1 }, tick: 0 },
			{ strict: true },
		);

		for (const ops of heard) applyOperations(replica, JSON.parse(JSON.stringify(ops)) as Array<Operation>, "do");

		expect(replica.box.a).toBe(2);
		expect(Object.hasOwn(replica.box, "meta")).toBe(false);
	});
});

describe("live-frozen occupants in lastSnapshot", () => {
	const lastSnapshotOf = (state: object): object => {
		const handle = handleOf(state);

		expect(handle).toBeDefined();

		return handle!.lastSnapshot;
	};

	it("re-pins a live-frozen nested node when a sibling on its parent writes", () => {
		const state = createMutableState({ shell: { holder: { n: 1 }, mark: 0 } });
		const lastSnapshot = lastSnapshotOf(state) as { shell: { holder: object } };
		const heard = new Array<ReadonlyArray<Operation>>();

		subscribe(state, (ops) => {
			heard.push([...ops]);
		});

		Object.freeze(state.shell.holder);

		expect(snapshot(state).shell.holder).not.toBe(state.shell.holder);
		expect(lastSnapshot.shell.holder).not.toBe(state.shell.holder);

		batch(() => {
			state.shell.mark = 1;
		});

		expect(heard.map(shapeOps)).toEqual([
			[
				{
					do: { verb: "assign", path: ["shell", "mark"], value: 1 },
					undo: { verb: "assign", path: ["shell", "mark"], value: 0 },
				},
			],
		]);
	});

	it("does not re-pin when a frozen occupant replaces a different object", () => {
		const original = { n: 1 };
		const replacement = Object.freeze({ n: 2 });
		const state = createMutableState({ box: original, tick: 0 });
		const lastSnapshot = lastSnapshotOf(state) as { box: object };
		const heard = new Array<ReadonlyArray<Operation>>();

		subscribe(state, (ops) => {
			heard.push([...ops]);
		});

		expect(lastSnapshot.box).not.toBe(state.box);
		expect(lastSnapshot.box).not.toBe(replacement);

		batch(() => {
			state.box = replacement;
			state.tick = 1;
		});

		expect(state.box).toBe(replacement);
		expect(heard.map(shapeOps)).toEqual([[...tickAssign(0, 1)]]);
	});

	it("copies array length including holes when re-pinning a frozen element", () => {
		const items: Array<{ n: number } | undefined> = [{ n: 1 }];

		items.length = 3;

		const state = createMutableState({ items });
		const lastSnapshot = lastSnapshotOf(state) as { items: Array<object | undefined> };
		const heard = new Array<ReadonlyArray<Operation>>();
		const element = state.items[0];

		subscribe(state, (ops) => {
			heard.push([...ops]);
		});

		expect(element).toBeDefined();
		expect(lastSnapshot.items.length).toBe(3);
		expect(Object.hasOwn(lastSnapshot.items, 1)).toBe(false);
		expect(lastSnapshot.items[0]).not.toBe(element);

		Object.freeze(element);

		expect(snapshot(state).items[0]).not.toBe(element);
		expect(lastSnapshot.items[0]).not.toBe(element);

		batch(() => {
			state.items[2] = { n: 2 };
		});

		expect(state.items.length).toBe(3);
		expect(Object.hasOwn(state.items, 1)).toBe(false);
		expect(heard.map(shapeOps)).toEqual([
			[
				{
					do: { verb: "assign", path: ["items", 2], value: { n: 2 }, ids: [3] },
					undo: { verb: "delete", path: ["items", 2] },
				},
			],
		]);
	});
});
