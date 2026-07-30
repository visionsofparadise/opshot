import { subscribe } from "../subscribe";
import { transact } from "../transact";
import { createGroup, type Group } from "../createGroup";
import { createMutableState } from "../createMutableState";
import { isSameIdentity } from "../identity";
import { applyOps } from "../ops/applyOps";
import { type Op } from "../ops/operation";

interface HistoryEntry {
	state: object;
	ops: Array<Op>;
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

			applyOps(
				entry.state,
				[...entry.ops].reverse().map((op) => op.undo),
				{ replay: true },
			);

			recorder.index -= 1;
		},
		redo: () => {
			const entry = stack[recorder.index + 1];

			if (!entry) return;

			applyOps(
				entry.state,
				entry.ops.map((op) => op.do),
				{ replay: true },
			);

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
	it("forwards every op of a transaction in order with its transactionKey intact", () => {
		const group = createGroup();
		const grade = createGrade(group);
		const received = new Array<{ meta: Record<string, unknown>; ops: Array<Op> }>();

		subscribe(group, (_state, ops, meta) => {
			received.push({ meta: meta as Record<string, unknown>, ops: [...ops] });
		});

		for (const exposure of [1, 2, 3]) {
			transact(
				grade,
				() => {
					grade.exposure = exposure;
				},
				{ transactionKey: "drag" },
			);
		}

		expect(received).toHaveLength(3);
		expect(received.every((entry) => entry.meta.transactionKey === "drag")).toBe(true);
		expect(received.map((emission) => emission.ops)).toEqual([
			[
				{
					do: { op: "assign", path: ["exposure"], value: 1 },
					undo: { op: "assign", path: ["exposure"], value: 0 },
				},
			],
			[
				{
					do: { op: "assign", path: ["exposure"], value: 2 },
					undo: { op: "assign", path: ["exposure"], value: 1 },
				},
			],
			[
				{
					do: { op: "assign", path: ["exposure"], value: 3 },
					undo: { op: "assign", path: ["exposure"], value: 2 },
				},
			],
		]);
	});

	it("Phase 6: restores the whole document across push, splice, and a nested parameter write", () => {
		const group = createGroup();
		const graph = createGraph(group);
		const recorder = createRecorder(group);

		expect(graph).toEqual(initialGraph);

		transact(graph, () => {
			graph.nodes.push({ id: "reverb", parameters: { gain: 4 } });
			graph.edges.push({ from: "output", to: "reverb" });
		});

		expect(graph).toEqual(pushedGraph);

		transact(graph, () => {
			graph.nodes.splice(1, 1);
			graph.edges.splice(0, 2);
		});

		expect(graph).toEqual(splicedGraph);

		transact(graph, () => {
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

		transact(grade, () => {
			grade.exposure = 1;
		});

		transact(grade, () => {
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

		transact(grade, () => {
			grade.exposure = 1;
		});

		recorder.undo();
		recorder.redo();

		expect(persisted).toEqual([undefined, { replay: true }, { replay: true }]);
	});

	it("completes the stream under entanglement: the sharer hears faithful side-effect ops for an owned write elsewhere", async () => {
		const shared = { x: 1 };
		const a = createMutableState({ box: shared });
		const b = createMutableState({ box: shared });
		const aHeard = new Array<{ ops: Array<Op>; meta: unknown }>();
		const bHeard = new Array<{ ops: Array<Op>; meta: unknown }>();

		subscribe(a, (ops, meta) => {
			aHeard.push({ ops: [...ops], meta });
		});
		subscribe(b, (ops, meta) => {
			bHeard.push({ ops: [...ops], meta });
		});

		transact(a, () => {
			a.box.x = 2;
		});

		expect(aHeard).toEqual([
			{
				ops: [
					{
						do: { op: "assign", path: ["box", "x"], value: 2 },
						undo: { op: "assign", path: ["box", "x"], value: 1 },
					},
				],
				meta: undefined,
			},
		]);
		expect(bHeard).toHaveLength(0);

		await Promise.resolve();

		expect(aHeard).toHaveLength(1);
		expect(bHeard).toEqual([
			{
				ops: [
					{
						do: { op: "assign", path: ["box", "x"], value: 2 },
						undo: { op: "assign", path: ["box", "x"], value: 1 },
					},
				],
				meta: undefined,
			},
		]);
		expect(b.box.x).toBe(2);
	});

	it("moves an element between states with both streams correct and the source detached", async () => {
		interface Item {
			id: string;
			gain: number;
		}

		const a = createMutableState<{ items: Array<Item> }>({ items: [{ id: "x", gain: 1 }] });
		const b = createMutableState<{ items: Array<Item> }>({ items: [] });
		const aHeard = new Array<{ ops: Array<Op>; meta: unknown }>();
		const bHeard = new Array<{ ops: Array<Op>; meta: unknown }>();

		subscribe(a, (ops, meta) => {
			aHeard.push({ ops: [...ops], meta });
		});
		subscribe(b, (ops, meta) => {
			bHeard.push({ ops: [...ops], meta });
		});

		let moved: Item | undefined;

		transact(a, () => {
			[moved] = a.items.splice(0, 1);
		});
		transact(b, () => {
			if (moved) b.items.push(moved);
		});

		expect(aHeard).toHaveLength(1);
		expect(aHeard[0]?.meta).toBeUndefined();
		expect(aHeard[0]?.ops).toHaveLength(1);
		expect(aHeard[0]?.ops[0]?.do).toMatchObject({ op: "assign", path: ["items"] });
		expect(aHeard[0]?.ops[0] && "value" in aHeard[0].ops[0].do ? aHeard[0].ops[0].do.value : undefined).toEqual([]);
		const sourceOps = aHeard[0]?.ops;

		if (!sourceOps) throw new Error("the source operations were not heard");

		const sourceUndo = [...sourceOps].reverse().map((pair) => pair.undo);

		expect(sourceUndo[0]).toMatchObject({ op: "assign", path: ["items"] });
		expect(sourceUndo[0] && "value" in sourceUndo[0] ? sourceUndo[0].value : undefined).toEqual([
			{ id: "x", gain: 1 },
		]);
		expect(bHeard).toHaveLength(1);
		expect(bHeard[0]?.meta).toBeUndefined();
		const destinationOps = bHeard[0]?.ops;

		if (!destinationOps) throw new Error("the destination operations were not heard");

		expect(destinationOps).toHaveLength(1);
		expect(destinationOps[0]?.do).toMatchObject({ op: "assign", path: ["items"] });
		expect(destinationOps[0] && "value" in destinationOps[0].do ? destinationOps[0].do.value : undefined).toEqual([
			{ id: "x", gain: 1 },
		]);

		await Promise.resolve();

		expect(aHeard).toHaveLength(1);
		expect(bHeard).toHaveLength(1);

		transact(b, () => {
			const item = b.items[0];

			if (item) item.gain = 2;
		});

		await Promise.resolve();

		expect(aHeard).toHaveLength(1);
		expect(bHeard).toHaveLength(2);
		expect(bHeard[1]?.meta).toBeUndefined();
		expect(bHeard[1]?.ops).toEqual([
			{
				do: { op: "assign", path: ["items", 0, "gain"], value: 2 },
				undo: { op: "assign", path: ["items", 0, "gain"], value: 1 },
			},
		]);
		expect(a.items).toEqual([]);
		expect(b.items).toEqual([{ id: "x", gain: 2 }]);
	});

	it("hears nothing from a standalone state the group never created", () => {
		const group = createGroup();
		const grade = createGrade(group);
		const selection = createMutableState<{ nodeId: string | undefined }>({ nodeId: undefined });
		const recorder = createRecorder(group);

		transact(selection, () => {
			selection.nodeId = "filter";
		});

		expect(recorder.stack).toHaveLength(0);

		transact(grade, () => {
			grade.exposure = 1;
		});

		const entry = recorder.stack[0];

		if (!entry) throw new Error("the recorder did not capture the grade mutation");

		expect(recorder.stack).toHaveLength(1);
		expect(isSameIdentity(entry.state, grade)).toBe(true);
		expect(isSameIdentity(entry.state, selection)).toBe(false);
	});
});
