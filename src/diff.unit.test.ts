import { proxy, ref, snapshot } from "valtio/vanilla";

import { diffSnapshots, type PatchOperation } from "./diff";

const readValue = (half: PatchOperation | undefined): unknown => (half !== undefined && "value" in half ? half.value : undefined);

describe("diffSnapshots", () => {
  it("reports a changed primitive as one replace pair at its path", () => {
    const ops = diffSnapshots({ count: 1 }, { count: 2 });

    expect(ops).toEqual([
      { do: { op: "replace", path: "/count", value: 2 }, undo: { op: "replace", path: "/count", value: 1 } },
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
      { do: { op: "replace", path: "/left/value", value: 10 }, undo: { op: "replace", path: "/left/value", value: 1 } },
    ]);
  });

  it("compares leaves with Object.is", () => {
    expect(diffSnapshots({ value: NaN }, { value: NaN })).toEqual([]);
    expect(diffSnapshots({ value: NaN }, { value: 1 })).toEqual([
      { do: { op: "replace", path: "/value", value: 1 }, undo: { op: "replace", path: "/value", value: NaN } },
    ]);
  });

  it("reports an added key as an add/remove pair and a removed key as a remove/add pair", () => {
    expect(diffSnapshots({}, { count: 1 })).toEqual([
      { do: { op: "add", path: "/count", value: 1 }, undo: { op: "remove", path: "/count" } },
    ]);
    expect(diffSnapshots({ count: 1 }, {})).toEqual([
      { do: { op: "remove", path: "/count" }, undo: { op: "add", path: "/count", value: 1 } },
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
      { do: { op: "replace", path: "/count", value: undefined }, undo: { op: "replace", path: "/count", value: 1 } },
    ]);
    expect(diffSnapshots({ count: undefined }, { count: 1 })).toEqual([
      { do: { op: "replace", path: "/count", value: 1 }, undo: { op: "replace", path: "/count", value: undefined } },
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
      { do: { op: "replace", path: "/list/1", value: 9 }, undo: { op: "replace", path: "/list/1", value: 2 } },
    ]);
  });

  it("reports a length change as one whole-array replace", () => {
    expect(diffSnapshots({ list: [1, 2] }, { list: [1, 2, 3] })).toEqual([
      { do: { op: "replace", path: "/list", value: [1, 2, 3] }, undo: { op: "replace", path: "/list", value: [1, 2] } },
    ]);
    expect(diffSnapshots({ list: [1, 2, 3] }, { list: [1, 3] })).toEqual([
      { do: { op: "replace", path: "/list", value: [1, 3] }, undo: { op: "replace", path: "/list", value: [1, 2, 3] } },
    ]);
  });

  it("identity-compares function fields", () => {
    const first = () => "a";
    const second = () => "b";

    expect(diffSnapshots({ run: first }, { run: first })).toEqual([]);
    expect(diffSnapshots({ run: first }, { run: second })).toEqual([
      { do: { op: "replace", path: "/run", value: second }, undo: { op: "replace", path: "/run", value: first } },
    ]);
  });

  it("replaces a leaf when the types mismatch", () => {
    const ops = diffSnapshots({ value: { nested: 1 } }, { value: 1 });

    expect(ops).toEqual([
      { do: { op: "replace", path: "/value", value: 1 }, undo: { op: "replace", path: "/value", value: { nested: 1 } } },
    ]);
  });

  it("emits an empty pointer for a change at the root", () => {
    const ops = diffSnapshots({ count: 1 }, 5);

    expect(ops).toEqual([
      { do: { op: "replace", path: "", value: 5 }, undo: { op: "replace", path: "", value: { count: 1 } } },
    ]);
  });

  it("escapes ~ before / in pointer segments", () => {
    expect(diffSnapshots({}, { "a/b": 1 })).toEqual([
      { do: { op: "add", path: "/a~1b", value: 1 }, undo: { op: "remove", path: "/a~1b" } },
    ]);
    expect(diffSnapshots({}, { "a~b": 1 })).toEqual([
      { do: { op: "add", path: "/a~0b", value: 1 }, undo: { op: "remove", path: "/a~0b" } },
    ]);
    expect(diffSnapshots({}, { "a~/b": 1 })).toEqual([
      { do: { op: "add", path: "/a~0~1b", value: 1 }, undo: { op: "remove", path: "/a~0~1b" } },
    ]);
  });

  it("mints a fresh clone on every read of a cloneable value", () => {
    const [op] = diffSnapshots({}, { document: { item: { value: 1 }, tags: ["a"] } });

    const first = readValue(op?.do) as { item: { value: number }; tags: Array<string> };
    const second = readValue(op?.do) as { item: { value: number }; tags: Array<string> };

    expect(first).not.toBe(second);
    expect(first.item).not.toBe(second.item);
    expect(first.tags).not.toBe(second.tags);
    expect(first).toEqual({ item: { value: 1 }, tags: ["a"] });
    expect(second).toEqual(first);
  });

  it("deep-freezes the source subtree it places in ops and hands out unfrozen clones", () => {
    const document = { item: { value: 1 }, tags: ["a"] };
    const [op] = diffSnapshots({}, { document });

    expect(op?.do.op).toBe("add");
    expect(Object.isFrozen(document)).toBe(true);
    expect(Object.isFrozen(document.item)).toBe(true);
    expect(Object.isFrozen(document.tags)).toBe(true);
    expect(() => document.tags.push("b")).toThrow(TypeError);
    expect(() => {
      document.item.value = 2;
    }).toThrow(TypeError);

    const clone = readValue(op?.do) as { item: { value: number }; tags: Array<string> };

    expect(Object.isFrozen(clone)).toBe(false);
    expect(Object.isFrozen(clone.item)).toBe(false);
    expect(Object.isFrozen(clone.tags)).toBe(false);

    clone.tags.push("b");
    clone.item.value = 2;

    expect(document).toEqual({ item: { value: 1 }, tags: ["a"] });
    expect(readValue(op?.do)).toEqual({ item: { value: 1 }, tags: ["a"] });
  });

  it("deep-freezes a shallow-frozen source container's children", () => {
    const inner = { x: 1 };
    const list = [1];
    const source = Object.freeze({ inner, list });

    expect(Object.isFrozen(inner)).toBe(false);
    expect(Object.isFrozen(list)).toBe(false);

    const [op] = diffSnapshots({}, { doc: source });

    expect(op?.do.op).toBe("add");
    expect(Object.isFrozen(inner)).toBe(true);
    expect(Object.isFrozen(list)).toBe(true);
    expect(() => {
      inner.x = 2;
    }).toThrow(TypeError);
    expect(() => list.push(2)).toThrow(TypeError);
  });

  it("leaves ref() values inside op values mutable", () => {
    const bookkeeping = ref({ entries: new Array<string>() });
    const document = { bookkeeping };
    const [op] = diffSnapshots({}, { document });

    expect(Object.isFrozen(document)).toBe(true);
    expect(Object.isFrozen(bookkeeping)).toBe(false);

    bookkeeping.entries.push("one");

    expect(bookkeeping.entries).toEqual(["one"]);
    expect(readValue(op?.do)).toEqual({ bookkeeping: { entries: ["one"] } });
  });

  it("treats a ref() value as an identity leaf", () => {
    const first = ref({ entries: [1] });
    const second = ref({ entries: [2] });
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

    expect(Object.isFrozen(document)).toBe(true);
    expect(Object.isFrozen(emitter)).toBe(false);

    emitter.count = 1;

    expect((readValue(op?.do) as { emitter: Emitter }).emitter.count).toBe(1);
  });

  it("hands identity leaves back un-cloned through the getter", () => {
    class Emitter {
      public count = 0;
    }

    const bookkeeping = ref({ entries: new Array<string>() });
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

  it("keeps producing correct generations after op values are frozen", () => {
    const state = proxy({ document: { item: { value: 1 }, tags: ["a"] } });

    const first = snapshot(state);

    state.document.tags.push("b");

    const second = snapshot(state);

    expect(diffSnapshots(first, second)).toEqual([
      {
        do: { op: "replace", path: "/document/tags", value: ["a", "b"] },
        undo: { op: "replace", path: "/document/tags", value: ["a"] },
      },
    ]);
    expect(Object.isFrozen(first.document.tags)).toBe(true);
    expect(Object.isFrozen(second.document.tags)).toBe(true);

    state.document.tags.push("c");

    const third = snapshot(state);

    expect(diffSnapshots(second, third)).toEqual([
      {
        do: { op: "replace", path: "/document/tags", value: ["a", "b", "c"] },
        undo: { op: "replace", path: "/document/tags", value: ["a", "b"] },
      },
    ]);
    expect(third.document.tags).toEqual(["a", "b", "c"]);
    expect(second.document.tags).toEqual(["a", "b"]);

    state.document.item.value = 2;

    const fourth = snapshot(state);

    expect(diffSnapshots(third, fourth)).toEqual([
      {
        do: { op: "replace", path: "/document/item/value", value: 2 },
        undo: { op: "replace", path: "/document/item/value", value: 1 },
      },
    ]);
    expect(fourth.document.tags).toBe(third.document.tags);
  });
});
