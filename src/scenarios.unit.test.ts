import { applyPatch } from "fast-json-patch";

import { createGroup, type Group } from "./createGroup";
import { createState, type State } from "./createState";
import { type Op } from "./diff";

interface HistoryEntry {
  state: State<object>;
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

      entry.state.mutate((mutable) => {
        applyPatch(
          mutable,
          [...entry.ops].reverse().map((op) => op.undo),
        );
      }, { replay: true });

      recorder.index -= 1;
    },
    redo: () => {
      const entry = stack[recorder.index + 1];

      if (!entry) return;

      entry.state.mutate((mutable) => {
        applyPatch(
          mutable,
          entry.ops.map((op) => op.do),
        );
      }, { replay: true });

      recorder.index += 1;
    },
  };

  group.subscribe((state, ops, meta) => {
    if (meta.replay === true) return;

    stack.length = recorder.index + 1;
    stack.push({ state, ops });
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

const createGrade = (group: Group): State<Grade> => group.createState<Grade>(() => ({ exposure: 0 }));

const createGraph = (group: Group): State<Graph> =>
  group.createState<Graph>(() => ({
    nodes: [
      { id: "input", parameters: { gain: 1 } },
      { id: "filter", parameters: { gain: 2 } },
      { id: "output", parameters: { gain: 3 } },
    ],
    edges: [
      { from: "input", to: "filter" },
      { from: "filter", to: "output" },
    ],
  }));

describe("scenarios", () => {
  it("forwards every op of a transaction in order with its transactionKey intact", () => {
    const group = createGroup();
    const grade = createGrade(group);
    const received = new Array<{ meta: Record<string, unknown>; ops: Array<Op> }>();

    group.subscribe((_state, ops, meta) => {
      received.push({ meta, ops });
    });

    for (const exposure of [1, 2, 3]) {
      grade.mutate((mutable) => {
        mutable.exposure = exposure;
      }, { transactionKey: "drag" });
    }

    expect(received).toHaveLength(3);
    expect(received.every((emission) => emission.meta.transactionKey === "drag")).toBe(true);
    expect(received.map((emission) => emission.ops)).toEqual([
      [{ do: { op: "replace", path: "/exposure", value: 1 }, undo: { op: "replace", path: "/exposure", value: 0 } }],
      [{ do: { op: "replace", path: "/exposure", value: 2 }, undo: { op: "replace", path: "/exposure", value: 1 } }],
      [{ do: { op: "replace", path: "/exposure", value: 3 }, undo: { op: "replace", path: "/exposure", value: 2 } }],
    ]);
  });

  it("restores the whole document across push, splice, and a nested parameter write", () => {
    const group = createGroup();
    const graph = createGraph(group);
    const recorder = createRecorder(group);

    expect(graph.op.unwrap()).toEqual(initialGraph);

    graph.mutate((mutable) => {
      mutable.nodes.push({ id: "reverb", parameters: { gain: 4 } });
      mutable.edges.push({ from: "output", to: "reverb" });
    });

    expect(graph.op.unwrap()).toEqual(pushedGraph);

    graph.mutate((mutable) => {
      mutable.nodes.splice(1, 1);
      mutable.edges.splice(0, 2);
    });

    expect(graph.op.unwrap()).toEqual(splicedGraph);

    graph.mutate((mutable) => {
      const node = mutable.nodes[0];

      if (node) node.parameters.gain = 99;
    });

    expect(graph.op.unwrap()).toEqual(parameterGraph);
    expect(recorder.stack).toHaveLength(3);

    recorder.undo();

    expect(graph.op.unwrap()).toEqual(splicedGraph);

    recorder.undo();

    expect(graph.op.unwrap()).toEqual(pushedGraph);

    recorder.undo();

    expect(graph.op.unwrap()).toEqual(initialGraph);

    recorder.redo();

    expect(graph.op.unwrap()).toEqual(pushedGraph);

    recorder.redo();

    expect(graph.op.unwrap()).toEqual(splicedGraph);

    recorder.redo();

    expect(graph.op.unwrap()).toEqual(parameterGraph);
  });

  it("does not record its own replays, so the stack survives undo and redo", () => {
    const group = createGroup();
    const grade = createGrade(group);
    const recorder = createRecorder(group);

    grade.mutate((mutable) => {
      mutable.exposure = 1;
    });

    grade.mutate((mutable) => {
      mutable.exposure = 2;
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
    expect(grade.op.unwrap().exposure).toBe(1);
  });

  it("emits to a persistence subscriber for organic mutations and for replays alike", () => {
    const group = createGroup();
    const grade = createGrade(group);
    const recorder = createRecorder(group);
    const persisted = new Array<Record<string, unknown>>();

    grade.op.subscribe((_state, _ops, meta) => {
      persisted.push(meta);
    });

    grade.mutate((mutable) => {
      mutable.exposure = 1;
    });

    recorder.undo();
    recorder.redo();

    expect(persisted).toEqual([{}, { replay: true }, { replay: true }]);
  });

  it("hears nothing from a standalone state the group never created", () => {
    const group = createGroup();
    const grade = createGrade(group);
    const selection = createState<{ nodeId: string | undefined }>(() => ({ nodeId: undefined }));
    const recorder = createRecorder(group);

    selection.mutate((mutable) => {
      mutable.nodeId = "filter";
    });

    expect(recorder.stack).toHaveLength(0);

    grade.mutate((mutable) => {
      mutable.exposure = 1;
    });

    expect(recorder.stack).toHaveLength(1);
    expect(recorder.stack[0]?.state.op.isSameState(grade)).toBe(true);
    expect(recorder.stack[0]?.state.op.isSameState(selection)).toBe(false);
  });
});

