import { proxy, snapshot } from "valtio/vanilla";

import { createState } from "../createState";
import { ignore } from "../ignore";
import { applyOps } from "./applyOps";
import { diffSnapshots } from "./diff";
import { type Op, type Operation } from "./operation";

const readValue = (half: Operation | undefined): unknown => (half !== undefined && "value" in half ? half.value : undefined);

const expectReplacePair = (op: Op | undefined, path: string, doValue: unknown, undoValue: unknown): void => {
  if (!op) throw new Error("the op was not produced");

  expect(op.isPatch).toBe(true);
  expect(op.do.op).toBe("replace");
  expect(op.do.path).toBe(path);
  expect(readValue(op.do)).toEqual(doValue);
  expect(op.undo.op).toBe("replace");
  expect(op.undo.path).toBe(path);
  expect(readValue(op.undo)).toEqual(undoValue);
};

describe("diffSnapshots", () => {
  it("reports a changed primitive as one replace pair at its path", () => {
    const ops = diffSnapshots({ count: 1 }, { count: 2 });

    expect(ops).toEqual([
      { isPatch: true, do: { op: "replace", path: "/count", value: 2 }, undo: { op: "replace", path: "/count", value: 1 } },
    ]);
  });

  it("reports a nested change as one replace pair at the deep path", () => {
    const shared = { untouched: true };
    const ops = diffSnapshots(
      { document: { item: { value: 1 } }, shared },
      { document: { item: { value: 2 } }, shared },
    );

    expect(ops).toEqual([
      {
        isPatch: true,
        do: { op: "replace", path: "/document/item/value", value: 2 },
        undo: { op: "replace", path: "/document/item/value", value: 1 },
      },
    ]);
  });

  it("produces no ops for an untouched sibling branch", () => {
    const state = proxy({ left: { value: 1 }, right: { value: 2 } });

    const before = snapshot(state);

    state.left.value = 10;

    const ops = diffSnapshots(before, snapshot(state));

    expect(ops).toEqual([
      { isPatch: true, do: { op: "replace", path: "/left/value", value: 10 }, undo: { op: "replace", path: "/left/value", value: 1 } },
    ]);
  });

  it("compares leaves with Object.is", () => {
    expect(diffSnapshots({ value: NaN }, { value: NaN })).toEqual([]);
    expect(diffSnapshots({ value: NaN }, { value: 1 })).toEqual([
      { isPatch: true, do: { op: "replace", path: "/value", value: 1 }, undo: { op: "replace", path: "/value", value: NaN } },
    ]);
  });

  it("reports an added key as an add/remove pair and a removed key as a remove/add pair", () => {
    expect(diffSnapshots({}, { count: 1 })).toEqual([
      { isPatch: true, do: { op: "add", path: "/count", value: 1 }, undo: { op: "remove", path: "/count" } },
    ]);
    expect(diffSnapshots({ count: 1 }, {})).toEqual([
      { isPatch: true, do: { op: "remove", path: "/count" }, undo: { op: "add", path: "/count", value: 1 } },
    ]);
  });

  it("carries presence on the op discriminant, never on the value", () => {
    const [added] = diffSnapshots({}, { count: 1 });
    const [removed] = diffSnapshots({ count: 1 }, {});

    expect(added?.undo).toEqual({ op: "remove", path: "/count" });
    expect("value" in (added?.undo ?? {})).toBe(false);
    expect(removed?.do).toEqual({ op: "remove", path: "/count" });
    expect("value" in (removed?.do ?? {})).toBe(false);
  });

  it("treats a key present with value undefined as present", () => {
    expect(diffSnapshots({ count: 1 }, { count: undefined })).toEqual([
      { isPatch: true, do: { op: "replace", path: "/count", value: undefined }, undo: { op: "replace", path: "/count", value: 1 } },
    ]);
    expect(diffSnapshots({ count: undefined }, { count: 1 })).toEqual([
      { isPatch: true, do: { op: "replace", path: "/count", value: 1 }, undo: { op: "replace", path: "/count", value: undefined } },
    ]);

    const [removed] = diffSnapshots({ count: undefined }, {});

    expect(removed?.do).toEqual({ op: "remove", path: "/count" });
    expect(removed?.undo.op).toBe("add");
    expect("value" in (removed?.undo ?? {})).toBe(true);
    expect(readValue(removed?.undo)).toBeUndefined();
  });

  it("recurses same-length arrays per index", () => {
    const ops = diffSnapshots({ list: [1, 2, 3] }, { list: [1, 9, 3] });

    expect(ops).toEqual([
      { isPatch: true, do: { op: "replace", path: "/list/1", value: 9 }, undo: { op: "replace", path: "/list/1", value: 2 } },
    ]);
  });

  it("keeps per-index ops when an index holds a present undefined on both sides", () => {
    const ops = diffSnapshots({ list: [1, undefined, 3] }, { list: [1, undefined, 9] });

    expect(ops).toEqual([
      { isPatch: true, do: { op: "replace", path: "/list/2", value: 9 }, undo: { op: "replace", path: "/list/2", value: 3 } },
    ]);
  });

  it("reports a length change as one whole-array replace", () => {
    const grown = diffSnapshots({ list: [1, 2] }, { list: [1, 2, 3] });

    expect(grown).toHaveLength(1);
    expectReplacePair(grown[0], "/list", [1, 2, 3], [1, 2]);

    const shrunk = diffSnapshots({ list: [1, 2, 3] }, { list: [1, 3] });

    expect(shrunk).toHaveLength(1);
    expectReplacePair(shrunk[0], "/list", [1, 3], [1, 2, 3]);
  });

  it("identity-compares function fields", () => {
    const first = () => "a";
    const second = () => "b";

    expect(diffSnapshots({ run: first }, { run: first })).toEqual([]);
    expect(diffSnapshots({ run: first }, { run: second })).toEqual([
      { isPatch: true, do: { op: "replace", path: "/run", value: second }, undo: { op: "replace", path: "/run", value: first } },
    ]);
  });

  it("replaces a leaf when the types mismatch", () => {
    const ops = diffSnapshots({ value: { nested: 1 } }, { value: 1 });

    expect(ops).toHaveLength(1);
    expectReplacePair(ops[0], "/value", 1, { nested: 1 });
  });

  it("emits an empty pointer for a change at the root", () => {
    const ops = diffSnapshots({ count: 1 }, 5);

    expect(ops).toHaveLength(1);
    expectReplacePair(ops[0], "", 5, { count: 1 });
  });

  it("escapes ~ before / in pointer segments", () => {
    expect(diffSnapshots({}, { "a/b": 1 })).toEqual([
      { isPatch: true, do: { op: "add", path: "/a~1b", value: 1 }, undo: { op: "remove", path: "/a~1b" } },
    ]);
    expect(diffSnapshots({}, { "a~b": 1 })).toEqual([
      { isPatch: true, do: { op: "add", path: "/a~0b", value: 1 }, undo: { op: "remove", path: "/a~0b" } },
    ]);
    expect(diffSnapshots({}, { "a~/b": 1 })).toEqual([
      { isPatch: true, do: { op: "add", path: "/a~0~1b", value: 1 }, undo: { op: "remove", path: "/a~0~1b" } },
    ]);
  });

  it("creates a fresh clone on every read of a cloneable value", () => {
    const [op] = diffSnapshots({}, { document: { item: { value: 1 }, tags: ["a"] } });

    const first = readValue(op?.do) as { item: { value: number }; tags: Array<string> };
    const second = readValue(op?.do) as { item: { value: number }; tags: Array<string> };

    expect(first).not.toBe(second);
    expect(first.item).not.toBe(second.item);
    expect(first.tags).not.toBe(second.tags);
    expect(first).toEqual({ item: { value: 1 }, tags: ["a"] });
    expect(second).toEqual(first);
  });

  it("leaves the source unfrozen; clones are independent of the record while the source stays shared", () => {
    const document = { item: { value: 1 }, tags: ["a"] };
    const [op] = diffSnapshots({}, { document });

    expect(op?.do.op).toBe("add");
    expect(Object.isFrozen(document)).toBe(false);

    const clone = readValue(op?.do) as { item: { value: number }; tags: Array<string> };

    clone.tags.push("b");
    clone.item.value = 2;

    expect(document).toEqual({ item: { value: 1 }, tags: ["a"] });
    expect(readValue(op?.do)).toEqual({ item: { value: 1 }, tags: ["a"] });

    document.item.value = 3;

    expect(readValue(op?.do)).toEqual({ item: { value: 3 }, tags: ["a"] });
  });

  it("leaves ignore() values inside op values mutable", () => {
    const bookkeeping = ignore({ entries: new Array<string>() });
    const document = { bookkeeping };
    const [op] = diffSnapshots({}, { document });

    bookkeeping.entries.push("one");

    expect(bookkeeping.entries).toEqual(["one"]);
    expect(readValue(op?.do)).toEqual({ bookkeeping: { entries: ["one"] } });
  });

  it("treats an ignore() value as an identity leaf", () => {
    const first = ignore({ entries: [1] });
    const second = ignore({ entries: [2] });
    const [op] = diffSnapshots({ bookkeeping: first }, { bookkeeping: second });

    expect(op?.do).toEqual({ op: "replace", path: "/bookkeeping", value: second });
    expect(readValue(op?.do)).toBe(second);
    expect(readValue(op?.undo)).toBe(first);
  });

  it("leaves class instances inside op values mutable", () => {
    class Emitter {
      public count = 0;
    }

    const emitter = new Emitter();
    const document = { emitter };
    const [op] = diffSnapshots({}, { document });

    emitter.count = 1;

    expect((readValue(op?.do) as { emitter: Emitter }).emitter.count).toBe(1);
  });

  it("hands identity leaves back un-cloned through the getter", () => {
    class Emitter {
      public count = 0;
    }

    const bookkeeping = ignore({ entries: new Array<string>() });
    const emitter = new Emitter();
    const run = () => "a";
    const [op] = diffSnapshots({}, { document: { bookkeeping, emitter, run } });

    const clone = readValue(op?.do) as { bookkeeping: object; emitter: Emitter; run: () => string };

    expect(clone.bookkeeping).toBe(bookkeeping);
    expect(clone.emitter).toBe(emitter);
    expect(clone.run).toBe(run);
    expect(Object.isFrozen(clone.bookkeeping)).toBe(false);
    expect(Object.isFrozen(clone.emitter)).toBe(false);
  });

  it("keeps producing correct generations after op values share snapshot subtrees", () => {
    const state = proxy({ document: { item: { value: 1 }, tags: ["a"] } });

    const first = snapshot(state);

    state.document.tags.push("b");

    const second = snapshot(state);

    const firstOps = diffSnapshots(first, second);

    expect(firstOps).toHaveLength(1);
    expectReplacePair(firstOps[0], "/document/tags", ["a", "b"], ["a"]);
    state.document.tags.push("c");

    const third = snapshot(state);
    const secondOps = diffSnapshots(second, third);

    expect(secondOps).toHaveLength(1);
    expectReplacePair(secondOps[0], "/document/tags", ["a", "b", "c"], ["a", "b"]);
    expect(third.document.tags).toEqual(["a", "b", "c"]);
    expect(second.document.tags).toEqual(["a", "b"]);

    state.document.item.value = 2;

    const fourth = snapshot(state);

    expect(diffSnapshots(third, fourth)).toEqual([
      {
        isPatch: true,
        do: { op: "replace", path: "/document/item/value", value: 2 },
        undo: { op: "replace", path: "/document/item/value", value: 1 },
      },
    ]);
    expect(fourth.document.tags).toBe(third.document.tags);
  });

  describe("accessors", () => {
    it("skips getter keys without invoking them while data keys still diff", () => {
      const makeSide = (count: number): object => ({
        count,
        get derived(): never {
          throw new Error("the diff invoked a getter");
        },
      });

      const ops = diffSnapshots(makeSide(1), makeSide(2));

      expect(ops).toEqual([
        { isPatch: true, do: { op: "replace", path: "/count", value: 2 }, undo: { op: "replace", path: "/count", value: 1 } },
      ]);
    });

    it("skips a key carrying a getter on either side alone, including presence changes", () => {
      const withGetter = {
        count: 1,
        get derived(): never {
          throw new Error("the diff invoked a getter");
        },
      };

      expect(diffSnapshots(withGetter, { count: 1, derived: 5 })).toEqual([]);
      expect(diffSnapshots({ count: 1, derived: 5 }, withGetter)).toEqual([]);
      expect(diffSnapshots({ count: 1 }, withGetter)).toEqual([]);
      expect(diffSnapshots(withGetter, { count: 1 })).toEqual([]);
    });
  });

  describe("dense-array presence escalation", () => {
    it("escalates a hole-to-stored-undefined change at fixed length to a whole-array replace", () => {
      // eslint-disable-next-line no-sparse-arrays
      const withHole = [1, , 3];
      const withUndefined = [1, undefined, 3];

      const ops = diffSnapshots({ list: withHole }, { list: withUndefined });

      expect(ops).toHaveLength(1);
      expectReplacePair(ops[0], "/list", [1, undefined, 3], withHole);
      expect(Object.hasOwn(readValue(ops[0]?.do) as Array<unknown>, 1)).toBe(true);
      expect(Object.hasOwn(readValue(ops[0]?.undo) as Array<unknown>, 1)).toBe(false);
    });

    it("escalates delete m.arr[1] to a whole-array replace whose halves round-trip hole-ness exactly", () => {
      const state = proxy<{ arr: Array<number | undefined> }>({ arr: [1, 2, 3] });
      const before = snapshot(state);

      delete state.arr[1];

      const after = snapshot(state);
      const ops = diffSnapshots(before, after);

      expect(ops).toHaveLength(1);
      expect(ops[0]?.do.path).toBe("/arr");

      const forward = createState<{ arr: Array<number | undefined> }>({ arr: [1, 2, 3] });

      applyOps(forward, [ops[0]!.do]);
      expect(Object.hasOwn(forward.op.unwrap().arr, 1)).toBe(false);
      expect(forward.op.unwrap().arr).toEqual([1, undefined, 3]);

      const backward = createState<{ arr: Array<number | undefined> }>({ arr: [] });

      applyOps(backward, [ops[0]!.undo]);
      expect(Object.hasOwn(backward.op.unwrap().arr, 1)).toBe(true);
      expect(backward.op.unwrap().arr[1]).toBe(2);
    });

    it("keeps per-index ops for a dense array of the same length", () => {
      const ops = diffSnapshots({ list: [1, 2, 3] }, { list: [1, 9, 3] });

      expect(ops).toEqual([
        { isPatch: true, do: { op: "replace", path: "/list/1", value: 9 }, undo: { op: "replace", path: "/list/1", value: 2 } },
      ]);
    });
  });

  describe("cycles", () => {
    it("throws a named cyclic error carrying the pointer, promptly, for cyclic before/after inputs", () => {
      const beforeCycle: { self?: unknown } = {};
      beforeCycle.self = beforeCycle;
      const afterCycle: { self?: unknown } = {};
      afterCycle.self = afterCycle;

      const start = performance.now();

      expect(() => diffSnapshots({ node: beforeCycle }, { node: afterCycle })).toThrow(
        "opshot: cyclic value at /node/self; use ignore() for back-linked structures, or ids",
      );
      expect(performance.now() - start).toBeLessThan(1000);
    });

    it("throws when reading a newly created cycle's op value, at emission", () => {
      const state = proxy<{ node: { self?: unknown } }>({ node: {} });
      const before = snapshot(state);

      state.node.self = state.node;

      const after = snapshot(state);
      const ops = diffSnapshots(before, after);

      expect(ops).toHaveLength(1);
      expect(() => readValue(ops[0]?.do)).toThrow(
        "opshot: cyclic value at /node/self; use ignore() for back-linked structures, or ids",
      );
    });

    it("treats an ignore()d cycle as a safe leaf, walked past unharmed", () => {
      const cyclicBefore: { self?: unknown } = {};
      cyclicBefore.self = cyclicBefore;
      const wrappedBefore = ignore(cyclicBefore);

      const cyclicAfter: { self?: unknown } = {};
      cyclicAfter.self = cyclicAfter;
      const wrappedAfter = ignore(cyclicAfter);

      const ops = diffSnapshots({ node: wrappedBefore }, { node: wrappedAfter });

      expect(ops).toEqual([
        { isPatch: true, do: { op: "replace", path: "/node", value: wrappedAfter }, undo: { op: "replace", path: "/node", value: wrappedBefore } },
      ]);
    });

    it("clones an op value with within-value aliasing preserved: left === right for a shared subtree", () => {
      const shared = { value: 1 };
      const [op] = diffSnapshots({}, { document: { left: shared, right: shared } });

      const clone = readValue(op?.do) as { left: { value: number }; right: { value: number } };

      expect(clone.left).toBe(clone.right);
      expect(clone.left).toEqual({ value: 1 });
    });

    it("does not false-trip a legitimate before-side DAG compared against genuine after-side cycles", () => {
      const shared = { tag: "shared" };

      const makeCyclic = (): { tag: string; self?: unknown } => {
        const node: { tag: string; self?: unknown } = { tag: "cyclic" };

        node.self = node;

        return node;
      };

      const ops = diffSnapshots({ a: shared, b: shared }, { a: makeCyclic(), b: makeCyclic() });

      expect(ops.map((op) => [op.do.op, op.do.path])).toEqual([
        ["replace", "/a/tag"],
        ["add", "/a/self"],
        ["replace", "/b/tag"],
        ["add", "/b/self"],
      ]);
    });
  });
});
