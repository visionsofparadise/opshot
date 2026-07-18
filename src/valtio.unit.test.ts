import { createProxy } from "proxy-compare";
import { proxy, ref, snapshot, subscribe, unstable_getInternalStates } from "valtio/vanilla";

describe("valtio assumptions", () => {
  it("shares one proxy-compare instance: snapshots are marked tracked and refs untracked", () => {
    const bookkeeping = ref({ entries: new Array<string>() });
    const state = proxy({ count: 0, bookkeeping });
    const snap = snapshot(state);

    const wrapped = createProxy(snap, new WeakMap(), new WeakMap(), new WeakMap());

    expect(wrapped).not.toBe(snap);
    expect(wrapped.bookkeeping).toBe(bookkeeping);
  });

  it("shares untouched subtrees across snapshot generations", () => {
    const state = proxy({ left: { value: 1 }, right: { value: 2 } });

    const before = snapshot(state);

    state.left.value = 10;

    const after = snapshot(state);

    expect(after).not.toBe(before);
    expect(after.right).toBe(before.right);
    expect(after.left).not.toBe(before.left);
    expect(after.left.value).toBe(10);
    expect(before.left.value).toBe(1);
  });

  it("caches the snapshot until a write, then rebuilds it synchronously", () => {
    const state = proxy({ count: 1 });

    const first = snapshot(state);

    expect(snapshot(state)).toBe(first);

    state.count = 2;

    const second = snapshot(state);

    expect(second).not.toBe(first);
    expect(second.count).toBe(2);
    expect(first.count).toBe(1);
    expect(snapshot(state)).toBe(second);
  });

  it("carries enumerable function fields onto snapshots by reference", () => {
    const greet = () => "hi";
    const state = proxy({ count: 0, greet });

    const first = snapshot(state);

    expect(Object.keys(first)).toContain("greet");
    expect(first.greet).toBe(greet);

    state.count = 1;

    const second = snapshot(state);

    expect(second.greet).toBe(greet);
    expect(second.greet()).toBe("hi");
  });

  it("carries ref() fields by reference and excludes them from change tracking", () => {
    const bookkeeping = ref({ entries: new Array<string>() });
    const state = proxy({ count: 0, bookkeeping });

    const first = snapshot(state);

    expect(first.bookkeeping).toBe(bookkeeping);

    bookkeeping.entries.push("one");

    expect(snapshot(state)).toBe(first);

    state.count = 1;

    const second = snapshot(state);

    expect(second).not.toBe(first);
    expect(second.bookkeeping).toBe(bookkeeping);
  });

  it("preserves getters through proxy() when properties are attached via defineProperty", () => {
    interface Counter {
      count: number;
      readonly doubled: number;
      readonly brand: string;
    }

    const literal = {
      count: 1,
      get doubled() {
        return this.count * 2;
      },
    } as Counter;

    Object.defineProperty(literal, "brand", {
      value: "opshot",
      enumerable: true,
      writable: false,
      configurable: false,
    });

    const state = proxy(literal);

    const first = snapshot(state);

    expect(first.doubled).toBe(2);
    expect(first.brand).toBe("opshot");

    state.count = 5;

    const second = snapshot(state);

    expect(second.doubled).toBe(10);
    expect(first.doubled).toBe(2);
  });

  it("reads a ref() handle assigned after proxy() through later snapshots", () => {
    interface Handle {
      unsafeMutable: object | undefined;
      isMutating: boolean;
    }

    interface Branded {
      value: number;
      readonly op: Handle;
    }

    const handle: Handle = { unsafeMutable: undefined, isMutating: false };
    const literal = { value: 1 } as Branded;

    Object.defineProperty(literal, "op", {
      value: ref(handle),
      enumerable: true,
      writable: false,
      configurable: false,
    });

    const state = proxy(literal);

    handle.unsafeMutable = state;

    const first = snapshot(state);

    expect(first.op).toBe(handle);
    expect(first.op.unsafeMutable).toBe(state);

    state.value = 2;

    const second = snapshot(state);

    expect(second.op).toBe(handle);
    expect(second.op.unsafeMutable).toBe(state);
  });

  it("leaves snapshots unfrozen: writes throw, adds and deletes and array growth corrupt the cached snapshot", () => {
    const state = proxy({ count: 1, list: [1, 2] });

    const snap = snapshot(state);

    expect(Object.isFrozen(snap)).toBe(false);
    expect(Object.isFrozen(snap.list)).toBe(false);
    expect(Object.getOwnPropertyDescriptor(snap, "count")).toEqual({
      value: 1,
      writable: false,
      enumerable: true,
      configurable: true,
    });
    expect(Object.getOwnPropertyDescriptor(snap, "list")).toMatchObject({
      writable: false,
      enumerable: true,
      configurable: true,
    });

    const mutable = snap as unknown as { count?: number; list: Array<number>; added?: number };

    expect(() => {
      mutable.count = 9;
    }).toThrow(TypeError);
    expect(() => {
      mutable.list[0] = 9;
    }).toThrow(TypeError);

    mutable.list.push(3);
    delete mutable.count;
    mutable.added = 1;

    expect(mutable.list).toEqual([1, 2, 3]);
    expect("count" in mutable).toBe(false);
    expect(mutable.added).toBe(1);

    expect(snapshot(state)).toBe(snap);
    expect(snapshot(state)).toEqual({ list: [1, 2, 3], added: 1 });
    expect(state.count).toBe(1);
  });

  it("keeps producing correct snapshot generations after a snapshot subtree is frozen", () => {
    const state = proxy({ document: { item: { value: 1 }, tags: ["a"] }, selection: { index: 0 } });

    const first = snapshot(state);

    Object.freeze(first.document);
    Object.freeze(first.document.item);
    Object.freeze(first.document.tags);

    expect(Object.isFrozen(first.document)).toBe(true);
    expect(Object.isFrozen(first.document.item)).toBe(true);
    expect(Object.isFrozen(first.document.tags)).toBe(true);

    state.selection.index = 1;

    const second = snapshot(state);

    expect(second).not.toBe(first);
    expect(second.document).toBe(first.document);
    expect(second.selection.index).toBe(1);

    state.document.item.value = 2;

    const third = snapshot(state);

    expect(third.document).not.toBe(first.document);
    expect(third.document.item).not.toBe(first.document.item);
    expect(third.document.item.value).toBe(2);
    expect(third.document.tags).toBe(first.document.tags);
    expect(third.selection.index).toBe(1);
    expect(first.document.item.value).toBe(1);

    state.document.tags.push("b");

    const fourth = snapshot(state);

    expect(fourth.document.tags).not.toBe(first.document.tags);
    expect(fourth.document.tags).toEqual(["a", "b"]);
    expect(fourth.document.item.value).toBe(2);
    expect(first.document.tags).toEqual(["a"]);

    state.document.tags.splice(0, 1);

    const fifth = snapshot(state);

    expect(fifth.document.tags).toEqual(["b"]);
    expect(fourth.document.tags).toEqual(["a", "b"]);
    expect(first.document.tags).toEqual(["a"]);
  });

  it("makes an assigned object the proxy's own target, forking the state from a retained reference", () => {
    const donated = { value: 1 };
    const state = proxy({ doc: { value: 0 }, tick: 0 });

    state.doc = donated;

    const cached = snapshot(state);

    expect(cached.doc).toEqual({ value: 1 });

    donated.value = 5;

    expect(state.doc.value).toBe(5);
    expect(snapshot(state)).toBe(cached);
    expect(snapshot(state).doc).toEqual({ value: 1 });

    state.tick = 1;

    expect(snapshot(state).doc).toEqual({ value: 1 });
    expect(state.doc.value).toBe(5);

    const written = proxy({ doc: { value: 0 } });
    const target = { value: 1 };

    written.doc = target;
    written.doc.value = 7;

    expect(target.value).toBe(7);
  });

  it("makes an assigned snapshot subtree a dead region: writes drop unfrozen, throw frozen", () => {
    const live = proxy({ doc: { item: { value: 0 } } });

    expect(Object.getOwnPropertyDescriptor(live.doc.item, "value")).toMatchObject({ writable: true });

    const unfrozenSource = proxy({ item: { value: 1 } });
    const unfrozenSnapshot = snapshot(unfrozenSource);
    const unfrozen = proxy({ doc: { item: { value: 0 } } });

    unfrozen.doc.item = unfrozenSnapshot.item as { value: number };

    expect(Object.getOwnPropertyDescriptor(unfrozen.doc.item, "value")).toMatchObject({ writable: false });

    unfrozen.doc.item.value = 5;

    expect(snapshot(unfrozen).doc).toEqual({ item: { value: 1 } });

    const frozenSource = proxy({ item: { value: 1 } });
    const frozenSnapshot = snapshot(frozenSource);

    Object.freeze(frozenSnapshot.item);

    const frozen = proxy({ doc: { item: { value: 0 } } });

    frozen.doc.item = frozenSnapshot.item as { value: number };

    expect(() => {
      frozen.doc.item.value = 5;
    }).toThrow(TypeError);

    expect(snapshot(frozen).doc).toEqual({ item: { value: 1 } });
  });

  it("identifies ref() values through unstable_getInternalStates().refSet, including values reached through snapshots", () => {
    const internals = unstable_getInternalStates();

    expect(internals.refSet).toBeInstanceOf(WeakSet);

    // diff.ts destructures refSet once at module load, so every later ref() must land in that same set.
    expect(unstable_getInternalStates().refSet).toBe(internals.refSet);

    const { refSet } = internals;

    const wrappedObject = ref({ entries: new Array<string>() });
    const wrappedArray = ref(new Array<string>());
    const plainObject = { entries: new Array<string>() };
    const plainArray = new Array<string>();

    const state = proxy({ count: 0, wrappedObject, wrappedArray, plainObject, plainArray });

    expect(refSet.has(wrappedObject)).toBe(true);
    expect(refSet.has(wrappedArray)).toBe(true);
    expect(refSet.has(plainObject)).toBe(false);
    expect(refSet.has(plainArray)).toBe(false);

    const first = snapshot(state);

    expect(refSet.has(first.wrappedObject)).toBe(true);
    expect(refSet.has(first.wrappedArray)).toBe(true);
    expect(refSet.has(first.plainObject)).toBe(false);
    expect(refSet.has(first.plainArray)).toBe(false);

    state.count = 1;

    const second = snapshot(state);

    expect(second).not.toBe(first);
    expect(refSet.has(second.wrappedObject)).toBe(true);
    expect(refSet.has(second.wrappedArray)).toBe(true);
    expect(refSet.has(second.plainObject)).toBe(false);
    expect(refSet.has(second.plainArray)).toBe(false);
  });

  it("batches a synchronous write burst into one subscribe callback, one per write with notifyInSync", async () => {
    const state = proxy({ count: 0 });

    const batched = new Array<number>();
    const inSync = new Array<number>();

    const unsubscribeBatched = subscribe(state, () => batched.push(state.count));
    const unsubscribeInSync = subscribe(state, () => inSync.push(state.count), true);

    state.count = 1;
    state.count = 2;
    state.count = 3;

    expect(batched).toEqual([]);
    expect(inSync).toEqual([1, 2, 3]);

    await Promise.resolve();

    expect(batched).toEqual([3]);
    expect(inSync).toEqual([1, 2, 3]);

    unsubscribeBatched();
    unsubscribeInSync();
  });
});
