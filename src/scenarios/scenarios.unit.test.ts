import { subscribe } from "../subscribe";
import { batch } from "../batch";
import { createGroup, type Group } from "../createGroup";
import { createMutableState } from "../createMutableState";
import { applyOperations } from "../ops/applyOperations";
import { type Operation } from "../ops/operation";
import { shapeOps } from "../ops/operationShape";

interface HistoryEntry {
	state: object;
	ops: Array<Operation>;
}

interface Recorder {
	stack: Array<HistoryEntry>;
	index: number;
	undo: () => void;
	redo: () => void;
}

const createRecorder = (group: Group): Recorder => {
	const stack = new Array<HistoryEntry>();

	const recorder: Recorder = {
		stack,
		index: -1,
		undo: () => {
			const entry = stack[recorder.index];

			if (!entry) return;

			applyOperations(entry.state, entry.ops, "undo", { replay: true });

			recorder.index -= 1;
		},
		redo: () => {
			const entry = stack[recorder.index + 1];

			if (!entry) return;

			applyOperations(entry.state, entry.ops, "do", { replay: true });

			recorder.index += 1;
		},
	};

	subscribe(group, (state, ops, meta) => {
		if ((meta as { replay?: boolean } | undefined)?.replay === true) return;

		stack.length = recorder.index + 1;
		stack.push({ state, ops: [...ops] });
		recorder.index = stack.length - 1;
	});

	return recorder;
};

interface Grade {
	exposure: number;
}

interface Graph {
	nodes: Array<{ id: string; parameters: { gain: number } }>;
	edges: Array<{ from: string; to: string }>;
}

const initialGraph: Graph = {
	nodes: [
		{ id: "input", parameters: { gain: 1 } },
		{ id: "filter", parameters: { gain: 2 } },
		{ id: "output", parameters: { gain: 3 } },
	],
	edges: [
		{ from: "input", to: "filter" },
		{ from: "filter", to: "output" },
	],
};

const pushedGraph: Graph = {
	nodes: [
		{ id: "input", parameters: { gain: 1 } },
		{ id: "filter", parameters: { gain: 2 } },
		{ id: "output", parameters: { gain: 3 } },
		{ id: "reverb", parameters: { gain: 4 } },
	],
	edges: [
		{ from: "input", to: "filter" },
		{ from: "filter", to: "output" },
		{ from: "output", to: "reverb" },
	],
};

const splicedGraph: Graph = {
	nodes: [
		{ id: "input", parameters: { gain: 1 } },
		{ id: "output", parameters: { gain: 3 } },
		{ id: "reverb", parameters: { gain: 4 } },
	],
	edges: [{ from: "output", to: "reverb" }],
};

const parameterGraph: Graph = {
	nodes: [
		{ id: "input", parameters: { gain: 99 } },
		{ id: "output", parameters: { gain: 3 } },
		{ id: "reverb", parameters: { gain: 4 } },
	],
	edges: [{ from: "output", to: "reverb" }],
};

const createGrade = (group: Group): Grade => group.createMutableState<Grade>({ exposure: 0 });

const createGraph = (group: Group): Graph =>
	group.createMutableState<Graph>({
		nodes: [
			{ id: "input", parameters: { gain: 1 } },
			{ id: "filter", parameters: { gain: 2 } },
			{ id: "output", parameters: { gain: 3 } },
		],
		edges: [
			{ from: "input", to: "filter" },
			{ from: "filter", to: "output" },
		],
	});

describe("scenarios", () => {
	it("forwards every op of a batch in order", () => {
		const group = createGroup();
		const grade = createGrade(group);
		const received = new Array<{ meta: Record<string, unknown>; ops: Array<Operation> }>();

		subscribe(group, (_state, ops, meta) => {
			received.push({ meta: meta as Record<string, unknown>, ops: [...ops] });
		});

		for (const exposure of [1, 2, 3]) {
			batch(
				() => {
					grade.exposure = exposure;
				},
				{ transactionKey: "drag" },
			);
		}

		expect(received).toHaveLength(3);
		expect(received.map((emission) => shapeOps(emission.ops))).toEqual([
			[
				{
					do: { verb: "assign", path: ["exposure"], value: 1 },
					undo: { verb: "assign", path: ["exposure"], value: 0 },
				},
			],
			[
				{
					do: { verb: "assign", path: ["exposure"], value: 2 },
					undo: { verb: "assign", path: ["exposure"], value: 1 },
				},
			],
			[
				{
					do: { verb: "assign", path: ["exposure"], value: 3 },
					undo: { verb: "assign", path: ["exposure"], value: 2 },
				},
			],
		]);
	});

	it("restores the whole document across push, splice, and a nested parameter write", () => {
		const group = createGroup();
		const graph = createGraph(group);
		const recorder = createRecorder(group);

		expect(graph).toEqual(initialGraph);

		batch(() => {
			graph.nodes.push({ id: "reverb", parameters: { gain: 4 } });
			graph.edges.push({ from: "output", to: "reverb" });
		});

		expect(graph).toEqual(pushedGraph);

		batch(() => {
			graph.nodes.splice(1, 1);
			graph.edges.splice(0, 2);
		});

		expect(graph).toEqual(splicedGraph);

		batch(() => {
			const node = graph.nodes[0];

			if (node) node.parameters.gain = 99;
		});

		expect(graph).toEqual(parameterGraph);
		expect(recorder.stack).toHaveLength(3);

		recorder.undo();

		expect(graph).toEqual(splicedGraph);

		recorder.undo();

		expect(graph).toEqual(pushedGraph);

		recorder.undo();

		expect(graph).toEqual(initialGraph);

		recorder.redo();

		expect(graph).toEqual(pushedGraph);

		recorder.redo();

		expect(graph).toEqual(splicedGraph);

		recorder.redo();

		expect(graph).toEqual(parameterGraph);
	});

	it("does not record its own replays, so the stack survives undo and redo", () => {
		const group = createGroup();
		const grade = createGrade(group);
		const recorder = createRecorder(group);

		batch(() => {
			grade.exposure = 1;
		});

		batch(() => {
			grade.exposure = 2;
		});

		expect(recorder.stack).toHaveLength(2);
		expect(recorder.index).toBe(1);

		recorder.undo();

		expect(recorder.stack).toHaveLength(2);
		expect(recorder.index).toBe(0);

		recorder.redo();

		expect(recorder.stack).toHaveLength(2);
		expect(recorder.index).toBe(1);

		recorder.undo();

		expect(recorder.stack).toHaveLength(2);
		expect(recorder.index).toBe(0);
		expect(grade.exposure).toBe(1);
	});

	it("emits to a persistence subscriber for organic mutations and for replays alike", () => {
		const group = createGroup();
		const grade = createGrade(group);
		const recorder = createRecorder(group);
		const persisted = new Array<Record<string, unknown>>();

		subscribe(grade, (_ops, meta) => {
			persisted.push(meta as Record<string, unknown>);
		});

		batch(() => {
			grade.exposure = 1;
		});

		recorder.undo();
		recorder.redo();

		expect(persisted).toEqual([undefined, { replay: true }, { replay: true }]);
	});

	it("completes the stream under entanglement: a bare write elsewhere reaches the sharer on its own window", async () => {
		const shared = { x: 1 };
		const a = createMutableState({ box: shared });
		const b = createMutableState({ box: shared });
		const aHeard = new Array<{ ops: Array<Operation>; meta: unknown }>();
		const bHeard = new Array<{ ops: Array<Operation>; meta: unknown }>();

		subscribe(a, (ops, meta) => {
			aHeard.push({ ops: [...ops], meta });
		});
		subscribe(b, (ops, meta) => {
			bHeard.push({ ops: [...ops], meta });
		});

		a.box.x = 2;

		expect(aHeard).toHaveLength(0);
		expect(bHeard).toHaveLength(0);

		await Promise.resolve();

		const shape = [
			{
				ops: [
					{
						do: { verb: "assign", path: ["box", "x"], value: 2 },
						undo: { verb: "assign", path: ["box", "x"], value: 1 },
					},
				],
				meta: undefined,
			},
		];

		expect(aHeard.map((entry) => ({ ops: shapeOps(entry.ops), meta: entry.meta }))).toEqual(shape);
		expect(bHeard.map((entry) => ({ ops: shapeOps(entry.ops), meta: entry.meta }))).toEqual(shape);
		expect(b.box.x).toBe(2);
	});

	it("completes the stream under entanglement: the sharer hears a write on the other state as a batch write", async () => {
		const shared = { x: 1 };
		const a = createMutableState({ box: shared });
		const b = createMutableState({ box: shared });
		const aHeard = new Array<{ ops: Array<Operation>; meta: unknown }>();
		const bHeard = new Array<{ ops: Array<Operation>; meta: unknown }>();

		subscribe(a, (ops, meta) => {
			aHeard.push({ ops: [...ops], meta });
		});
		subscribe(b, (ops, meta) => {
			bHeard.push({ ops: [...ops], meta });
		});

		batch(
			() => {
				a.box.x = 2;
			},
			{ transactionKey: "drag" },
		);

		const ops = [
			{
				do: { verb: "assign", path: ["box", "x"], value: 2 },
				undo: { verb: "assign", path: ["box", "x"], value: 1 },
			},
		];

		expect(aHeard.map((entry) => ({ ops: shapeOps(entry.ops), meta: entry.meta }))).toEqual([
			{ ops, meta: { transactionKey: "drag" } },
		]);
		expect(bHeard.map((entry) => ({ ops: shapeOps(entry.ops), meta: entry.meta }))).toEqual([
			{ ops, meta: { transactionKey: "drag" } },
		]);

		await Promise.resolve();

		expect(aHeard).toHaveLength(1);
		expect(bHeard).toHaveLength(1);
		expect(b.box.x).toBe(2);
	});

	it("moves an element between states with both streams correct and the source detached", async () => {
		interface Item {
			id: string;
			gain: number;
		}

		const a = createMutableState<{ items: Array<Item> }>({ items: [{ id: "x", gain: 1 }] });
		const b = createMutableState<{ items: Array<Item> }>({ items: [] });
		const aHeard = new Array<{ ops: Array<Operation>; meta: unknown }>();
		const bHeard = new Array<{ ops: Array<Operation>; meta: unknown }>();

		subscribe(a, (ops, meta) => {
			aHeard.push({ ops: [...ops], meta });
		});
		subscribe(b, (ops, meta) => {
			bHeard.push({ ops: [...ops], meta });
		});

		let moved: Item | undefined;

		batch(() => {
			[moved] = a.items.splice(0, 1);
		});
		batch(() => {
			if (moved) b.items.push(moved);
		});

		expect(aHeard).toHaveLength(1);
		expect(aHeard[0]?.meta).toBeUndefined();
		expect(shapeOps(aHeard[0]?.ops ?? [])).toEqual([
			{
				do: { verb: "delete", path: ["items", 0] },
				undo: { verb: "assign", path: ["items", 0], value: { id: "x", gain: 1 }, ids: [2] },
			},
			{
				do: { verb: "assign", path: ["items", "length"], value: 0 },
				undo: { verb: "assign", path: ["items", "length"], value: 1 },
			},
		]);
		expect(bHeard).toHaveLength(1);
		expect(bHeard[0]?.meta).toBeUndefined();
		const destinationOps = bHeard[0]?.ops;

		if (!destinationOps) throw new Error("the destination operations were not heard");

		expect(shapeOps(destinationOps)).toEqual([
			{
				do: { verb: "assign", path: ["items", "length"], value: 1 },
				undo: { verb: "assign", path: ["items", "length"], value: 0 },
			},
			{
				do: { verb: "assign", path: ["items", 0], value: { id: "x", gain: 1 }, ids: [2] },
				undo: { verb: "delete", path: ["items", 0] },
			},
		]);

		await Promise.resolve();

		expect(aHeard).toHaveLength(1);
		expect(bHeard).toHaveLength(1);

		batch(() => {
			const item = b.items[0];

			if (item) item.gain = 2;
		});

		await Promise.resolve();

		expect(aHeard).toHaveLength(1);
		expect(bHeard).toHaveLength(2);
		expect(bHeard[1]?.meta).toBeUndefined();
		expect(shapeOps(bHeard[1]?.ops ?? [])).toEqual([
			{
				do: { verb: "assign", path: ["items", 0, "gain"], value: 2 },
				undo: { verb: "assign", path: ["items", 0, "gain"], value: 1 },
			},
		]);
		expect(a.items).toEqual([]);
		expect(b.items).toEqual([{ id: "x", gain: 2 }]);
	});
});
