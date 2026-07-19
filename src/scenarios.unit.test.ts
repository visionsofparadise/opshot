import { applyPatch } from "fast-json-patch";

import { createGroup, type Group } from "./createGroup";
import { createState, type Emission, type State } from "./createState";
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

  group.subscribe((state, ops, emission) => {
    if (emission.isSideEffect || emission.meta.replay === true) return;

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

    group.subscribe((_state, ops, emission) => {
      if (!emission.isSideEffect) received.push({ meta: emission.meta, ops });
    });

    for (const exposure of [1, 2, 3]) {
      grade.mutate((mutable) => {
        mutable.exposure = exposure;
      }, { transactionKey: "drag" });
    }

    expect(received).toHaveLength(3);
    expect(received.every((emission) => emission.meta.transactionKey === "drag")).toBe(true);
    expect(received.map((emission) => emission.ops)).toEqual([
      [{ isPatch: true, do: { op: "replace", path: "/exposure", value: 1 }, undo: { op: "replace", path: "/exposure", value: 0 } }],
      [{ isPatch: true, do: { op: "replace", path: "/exposure", value: 2 }, undo: { op: "replace", path: "/exposure", value: 1 } }],
      [{ isPatch: true, do: { op: "replace", path: "/exposure", value: 3 }, undo: { op: "replace", path: "/exposure", value: 2 } }],
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

    grade.op.subscribe((_state, _ops, emission) => {
      if (!emission.isSideEffect) persisted.push(emission.meta);
    });

    grade.mutate((mutable) => {
      mutable.exposure = 1;
    });

    recorder.undo();
    recorder.redo();

    expect(persisted).toEqual([{}, { replay: true }, { replay: true }]);
  });

  it("completes the stream under entanglement: the sharer hears faithful side-effect ops for an owned write elsewhere", async () => {
    const shared = { x: 1 };
    const a = createState({ box: shared });
    const b = createState({ box: shared });
    const aHeard = new Array<{ ops: Array<Op>; emission: Emission }>();
    const bHeard = new Array<{ ops: Array<Op>; emission: Emission }>();

    a.op.subscribe((_state, ops, emission) => {
      aHeard.push({ ops, emission });
    });
    b.op.subscribe((_state, ops, emission) => {
      bHeard.push({ ops, emission });
    });

    a.mutate((mutable) => {
      mutable.box.x = 2;
    });

    expect(aHeard).toEqual([
      {
        ops: [{ isPatch: true, do: { op: "replace", path: "/box/x", value: 2 }, undo: { op: "replace", path: "/box/x", value: 1 } }],
        emission: { isSideEffect: false, meta: {} },
      },
    ]);
    expect(bHeard).toHaveLength(0);

    await Promise.resolve();

    expect(aHeard).toHaveLength(1);
    expect(bHeard).toEqual([
      {
        ops: [{ isPatch: true, do: { op: "replace", path: "/box/x", value: 2 }, undo: { op: "replace", path: "/box/x", value: 1 } }],
        emission: { isSideEffect: true },
      },
    ]);
    expect(b.op.unwrap().box.x).toBe(2);
  });

  it("moves an element between states with both streams correct and the source detached", async () => {
    interface Item {
      id: string;
      gain: number;
    }

    const a = createState<{ items: Array<Item> }>({ items: [{ id: "x", gain: 1 }] });
    const b = createState<{ items: Array<Item> }>({ items: [] });
    const aHeard = new Array<{ ops: Array<Op>; emission: Emission }>();
    const bHeard = new Array<{ ops: Array<Op>; emission: Emission }>();

    a.op.subscribe((_state, ops, emission) => {
      aHeard.push({ ops, emission });
    });
    b.op.subscribe((_state, ops, emission) => {
      bHeard.push({ ops, emission });
    });

    let moved: Item | undefined;

    a.mutate((mutable) => {
      [moved] = mutable.items.splice(0, 1);
    });
    b.mutate((mutable) => {
      if (moved) mutable.items.push(moved);
    });

    expect(aHeard).toHaveLength(1);
    expect(aHeard[0]?.emission).toEqual({ isSideEffect: false, meta: {} });
    expect(aHeard[0]?.ops).toEqual([
      { isPatch: true, do: { op: "replace", path: "/items", value: [] }, undo: { op: "replace", path: "/items", value: [{ id: "x", gain: 1 }] } },
    ]);
    expect(bHeard).toHaveLength(1);
    expect(bHeard[0]?.emission).toEqual({ isSideEffect: false, meta: {} });
    expect(bHeard[0]?.ops).toEqual([
      { isPatch: true, do: { op: "replace", path: "/items", value: [{ id: "x", gain: 1 }] }, undo: { op: "replace", path: "/items", value: [] } },
    ]);

    await Promise.resolve();

    expect(aHeard).toHaveLength(1);
    expect(bHeard).toHaveLength(1);

    b.mutate((mutable) => {
      const item = mutable.items[0];

      if (item) item.gain = 2;
    });

    await Promise.resolve();

    expect(aHeard).toHaveLength(1);
    expect(bHeard).toHaveLength(2);
    expect(bHeard[1]?.emission).toEqual({ isSideEffect: false, meta: {} });
    expect(bHeard[1]?.ops).toEqual([
      { isPatch: true, do: { op: "replace", path: "/items/0/gain", value: 2 }, undo: { op: "replace", path: "/items/0/gain", value: 1 } },
    ]);
    expect(a.op.unwrap().items).toEqual([]);
    expect(b.op.unwrap().items).toEqual([{ id: "x", gain: 2 }]);
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

