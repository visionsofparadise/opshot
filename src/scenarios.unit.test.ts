import { applyPatch } from "fast-json-patch";

import { createGroup, type Group } from "./createGroup";
import { createState, type MutateOptions, type State } from "./createState";
import { type Op } from "./diff";
import { unwrap } from "./unwrap";

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

      entry.state.op.mutate((draft) => {
        applyPatch(
          draft,
          [...entry.ops].reverse().map((op) => op.undo),
        );
      }, { appliedOps: true });

      recorder.index -= 1;
    },
    redo: () => {
      const entry = stack[recorder.index + 1];

      if (!entry) return;

      entry.state.op.mutate((draft) => {
        applyPatch(
          draft,
          entry.ops.map((op) => op.do),
        );
      }, { appliedOps: true });

      recorder.index += 1;
    },
  };

  group.subscribe((state, ops, options) => {
    if (options.appliedOps === true) return;

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
    const received = new Array<{ options: MutateOptions; ops: Array<Op> }>();

    group.subscribe((_state, ops, options) => {
      received.push({ options, ops });
    });

    for (const exposure of [1, 2, 3]) {
      grade.op.mutate((draft) => {
        draft.exposure = exposure;
      }, { transactionKey: "drag" });
    }

    expect(received).toHaveLength(3);
    expect(received.every((emission) => emission.options.transactionKey === "drag")).toBe(true);
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

    expect(unwrap(graph)).toEqual(initialGraph);

    graph.op.mutate((draft) => {
      draft.nodes.push({ id: "reverb", parameters: { gain: 4 } });
      draft.edges.push({ from: "output", to: "reverb" });
    });

    expect(unwrap(graph)).toEqual(pushedGraph);

    graph.op.mutate((draft) => {
      draft.nodes.splice(1, 1);
      draft.edges.splice(0, 2);
    });

    expect(unwrap(graph)).toEqual(splicedGraph);

    graph.op.mutate((draft) => {
      const node = draft.nodes[0];

      if (node) node.parameters.gain = 99;
    });

    expect(unwrap(graph)).toEqual(parameterGraph);
    expect(recorder.stack).toHaveLength(3);

    recorder.undo();

    expect(unwrap(graph)).toEqual(splicedGraph);

    recorder.undo();

    expect(unwrap(graph)).toEqual(pushedGraph);

    recorder.undo();

    expect(unwrap(graph)).toEqual(initialGraph);

    recorder.redo();

    expect(unwrap(graph)).toEqual(pushedGraph);

    recorder.redo();

    expect(unwrap(graph)).toEqual(splicedGraph);

    recorder.redo();

    expect(unwrap(graph)).toEqual(parameterGraph);
  });

  it("does not record its own replays, so the stack survives undo and redo", () => {
    const group = createGroup();
    const grade = createGrade(group);
    const recorder = createRecorder(group);

    grade.op.mutate((draft) => {
      draft.exposure = 1;
    });

    grade.op.mutate((draft) => {
      draft.exposure = 2;
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
    expect(unwrap(grade).exposure).toBe(1);
  });

  it("emits to a persistence subscriber for organic mutations and for replays alike", () => {
    const group = createGroup();
    const grade = createGrade(group);
    const recorder = createRecorder(group);
    const persisted = new Array<MutateOptions>();

    grade.op.subscribe((_state, _ops, options) => {
      persisted.push(options);
    });

    grade.op.mutate((draft) => {
      draft.exposure = 1;
    });

    recorder.undo();
    recorder.redo();

    expect(persisted).toEqual([{}, { appliedOps: true }, { appliedOps: true }]);
  });

  it("hears nothing from a standalone state the group never minted", () => {
    const group = createGroup();
    const grade = createGrade(group);
    const selection = createState<{ nodeId: string | undefined }>(() => ({ nodeId: undefined }));
    const recorder = createRecorder(group);

    selection.op.mutate((draft) => {
      draft.nodeId = "filter";
    });

    expect(recorder.stack).toHaveLength(0);

    grade.op.mutate((draft) => {
      draft.exposure = 1;
    });

    expect(recorder.stack).toHaveLength(1);
    expect(recorder.stack[0]?.state.op.isSameState(grade)).toBe(true);
    expect(recorder.stack[0]?.state.op.isSameState(selection)).toBe(false);
  });
});

