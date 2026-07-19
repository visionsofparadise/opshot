import { affectedToPathList, createProxy, isChanged, markToTrack } from "proxy-compare";
import { proxy, ref, snapshot, subscribe, unstable_getInternalStates, unstable_replaceInternalFunction, type INTERNAL_Op } from "valtio/vanilla";

// Local aliases for valtio's internal seam signatures, which the package's public types do not export.
type ValtioOp = INTERNAL_Op;
type NotifyUpdate = (op: ValtioOp | undefined) => void;
type ValtioListener = (op: ValtioOp | undefined, nextVersion: number) => void;
type AddListener = (listener: ValtioListener) => () => void;
type CreateHandler = <T extends object>(
	isInitializing: () => boolean,
	addPropListener: (prop: string | symbol, propValue: unknown) => void,
	removePropListener: (prop: string | symbol) => void,
	notifyUpdate: NotifyUpdate,
) => ProxyHandler<T>;
type CreateSnapshot = <T extends object>(target: T, version: number) => T;

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

  it("proxies and snapshots a cyclic graph, producing a cyclic snapshot", () => {
    // snapCache seeds before the property walk, so cyclic proxies are legal input: opshot's cycle
    // design (diff and clone getter throw; retrack skips) assumes valtio itself never hangs or
    // throws on a cycle. Graduated from scratch/spike-graphs.test.ts.
    const state = proxy<{ node: { x: number; self?: unknown } }>({ node: { x: 1 } });

    state.node.self = state.node;

    const snap = snapshot(state);

    expect(snap.node.self).toBe(snap.node);
  });
});

describe("canProxy seam", () => {
  const { refSet } = unstable_getInternalStates();

  let defaultCanProxy: (value: unknown) => boolean;

  beforeAll(() => {
    unstable_replaceInternalFunction("canProxy", (current) => {
      defaultCanProxy = current;

      return (value) => {
        if (typeof value !== "object" || value === null) return current(value);
        if (refSet.has(value)) return false;
        if (Object.isFrozen(value)) return false;
        if (value instanceof Map) throw new Error("canProxy probe: Map rejected");

        return current(value);
      };
    });
  });

  afterAll(() => {
    unstable_replaceInternalFunction("canProxy", () => defaultCanProxy);
  });

  it("hands the replacer the current predicate and installs its return value", () => {
    expect(typeof defaultCanProxy).toBe("function");
    expect(defaultCanProxy(new Map())).toBe(false);
    expect(defaultCanProxy({})).toBe(true);
  });

  it("surfaces a replacement throw synchronously at proxy() when the literal carries an offending value", () => {
    expect(() => proxy({ m: new Map() })).toThrow("canProxy probe: Map rejected");
  });

  it("surfaces a replacement throw synchronously at proxy() for an offending nested child", () => {
    expect(() => proxy({ outer: { m: new Map() } })).toThrow("canProxy probe: Map rejected");
  });

  it("surfaces a replacement throw synchronously at the assigning line", () => {
    const state = proxy<{ box: unknown }>({ box: null });

    expect(() => {
      state.box = new Map();
    }).toThrow("canProxy probe: Map rejected");
  });

  it("short-circuits ref() members before the throw when the replacement checks refSet first", () => {
    const state = proxy<{ box: unknown }>({ box: null });
    const kept = ref(new Map([["k", "v"]]));

    state.box = kept;

    expect(state.box).toBe(kept);
    expect(snapshot(state).box).toBe(kept);
  });

  it("short-circuits frozen plain objects before the throw when the replacement checks isFrozen first", () => {
    const state = proxy<{ box: unknown }>({ box: null });
    const frozen = Object.freeze({ value: 1 });

    state.box = frozen;

    expect(state.box).toBe(frozen);
    expect(snapshot(state).box).toBe(frozen);
  });
});

describe("canProxy seam restored", () => {
  it("proxies a Map again once the captured default is wrapped back", () => {
    const state = proxy({ m: new Map() });

    expect(state.m).toBeInstanceOf(Map);
  });
});

// Phase 1.2 reference implementation for the Phase 3 permanent install in boundary.ts.
// The reentrancy counter is what makes a throwing defineProperty trap viable: valtio's set trap
// ends in Reflect.set(target, prop, value, receiver=proxy), and per ECMAScript
// OrdinarySetWithOwnDescriptor completes every such write via receiver.[[DefineOwnProperty]] — the
// proxy's defineProperty trap. Without the guard the trap would throw on every ordinary write. A
// counter (not a boolean) survives nested set activity: child-proxy creation during a write nests
// set calls, and only the outermost's exit returns the guard to zero.
describe("createHandler seam: throwing defineProperty/setPrototypeOf traps", () => {
  let defaultCreateHandler: CreateHandler;
  let setDepth = 0;

  beforeAll(() => {
    unstable_replaceInternalFunction("createHandler", (current) => {
      defaultCreateHandler = current;

      const replacement: CreateHandler = (isInitializing, addPropListener, removePropListener, notifyUpdate) => {
        const handler = current(isInitializing, addPropListener, removePropListener, notifyUpdate);

        return {
          ...handler,
          set(target, prop, value, receiver) {
            setDepth += 1;

            try {
              return handler.set!(target, prop, value, receiver);
            } finally {
              setDepth -= 1;
            }
          },
          defineProperty(target, prop, descriptor) {
            if (setDepth > 0 || isInitializing()) return Reflect.defineProperty(target, prop, descriptor);

            throw new Error("opshot: defineProperty is not supported on tracked state; define properties in the createState literal");
          },
          setPrototypeOf() {
            throw new Error("opshot: setPrototypeOf is not supported on tracked state");
          },
        };
      };

      return replacement;
    });
  });

  afterAll(() => {
    unstable_replaceInternalFunction("createHandler", () => defaultCreateHandler);
  });

  it("passes ordinary set-driven defines through the counter guard", () => {
    const state = proxy<{ x: number; a: { b: number } }>({ x: 0, a: { b: 0 } });

    state.x = 1;
    state.a.b = 5;

    expect(state.x).toBe(1);
    expect(state.a.b).toBe(5);
    expect(setDepth).toBe(0);
  });

  it("passes a nested child-replacing write through the guard", () => {
    const state = proxy<{ a: { b: number } }>({ a: { b: 0 } });

    state.a = { b: 9 };

    expect(state.a.b).toBe(9);
    expect(setDepth).toBe(0);
  });

  it("leaves deleteProperty working", () => {
    const state = proxy<{ x?: number }>({ x: 1 });

    delete state.x;

    expect("x" in state).toBe(false);
  });

  it("throws the added error on a consumer Object.defineProperty", () => {
    const state = proxy<Record<string, unknown>>({});

    expect(() => Object.defineProperty(state, "y", { value: 1 })).toThrow("opshot: defineProperty is not supported on tracked state");
    expect(setDepth).toBe(0);
  });

  it("throws the added error on Object.setPrototypeOf", () => {
    const state = proxy<Record<string, unknown>>({});

    expect(() => Object.setPrototypeOf(state, null)).toThrow("opshot: setPrototypeOf is not supported on tracked state");
  });
});

// Phase 1.3 reference implementation for the Phase 6 createSnapshot install in boundary.ts.
// Reimplements createSnapshotDefault (vanilla.mjs) with one added branch: an own accessor
// descriptor copies as a live getter/setter instead of materializing via Reflect.get. The
// replacement must self-recurse, since the default recurses to child snapshots by its own name.
describe("createSnapshot seam: accessor preservation", () => {
  const { refSet, proxyStateMap, snapCache } = unstable_getInternalStates();

  let defaultCreateSnapshot: CreateSnapshot;

  const createSnapshotPreservingAccessors = <T extends object>(target: T, version: number): T => {
    const cached = snapCache.get(target) as [number, T] | undefined;

    if (cached?.[0] === version) return cached[1];

    const snap: object = Array.isArray(target) ? [] : Object.create(Object.getPrototypeOf(target) as object | null);

    markToTrack(snap, true);
    snapCache.set(target, [version, snap]);

    Reflect.ownKeys(target).forEach((key) => {
      if (Object.getOwnPropertyDescriptor(snap, key)) return;

      const descriptor = Reflect.getOwnPropertyDescriptor(target, key)!;

      if (descriptor.get || descriptor.set) {
        Object.defineProperty(snap, key, {
          get: descriptor.get,
          set: descriptor.set,
          enumerable: descriptor.enumerable,
          configurable: true,
        });

        return;
      }

      const value = Reflect.get(target, key) as unknown;
      const desc: PropertyDescriptor = { value, enumerable: descriptor.enumerable, configurable: true };

      if (refSet.has(value as object)) {
        markToTrack(value as object, false);
      } else if (proxyStateMap.has(value as object)) {
        const [childTarget, ensureVersion] = proxyStateMap.get(value as object)!;

        desc.value = createSnapshotPreservingAccessors(childTarget, ensureVersion());
      }

      Object.defineProperty(snap, key, desc);
    });

    return snap as T;
  };

  beforeAll(() => {
    unstable_replaceInternalFunction("createSnapshot", (current) => {
      defaultCreateSnapshot = current;

      return createSnapshotPreservingAccessors;
    });
  });

  afterAll(() => {
    unstable_replaceInternalFunction("createSnapshot", () => defaultCreateSnapshot);
  });

  interface Temperature {
    celsius: number;
    readonly fahrenheit: number;
    other: { n: number };
  }

  const makeState = (): Temperature =>
    proxy({
      celsius: 0,
      other: { n: 1 },
      get fahrenheit() {
        return (this.celsius * 9) / 5 + 32;
      },
    } as Temperature);

  it("keeps the own getter live so it recomputes against the snapshot receiver", () => {
    const state = makeState();

    state.celsius = 20;

    const snap = snapshot(state);

    expect(snap.fahrenheit).toBe(68);
    expect(Object.getOwnPropertyDescriptor(snap, "fahrenheit")?.get).toBeTypeOf("function");
  });

  it("recomputes per generation while older generations hold their own value", () => {
    const state = makeState();
    const first = snapshot(state);

    state.celsius = 20;

    const second = snapshot(state);

    expect(first.fahrenheit).toBe(32);
    expect(second.fahrenheit).toBe(68);
  });

  it("keeps valtio's snapshot cache and untouched-subtree sharing through the replacement", () => {
    const state = makeState();
    const first = snapshot(state);

    expect(snapshot(state)).toBe(first);

    state.celsius = 20;

    const second = snapshot(state);

    expect(second).not.toBe(first);
    expect(second.other).toBe(first.other);
  });

  it("records only the getter key on a proxy-compare read, yet gates correctly by per-generation value", () => {
    const state = makeState();

    state.celsius = 20;

    const first = snapshot(state);
    const affected = new WeakMap<object, unknown>();
    const wrapped = createProxy(first, affected, new WeakMap(), new WeakMap());

    expect(wrapped.fahrenheit).toBe(68);

    // proxy-compare's get trap reads via Reflect.get(target, key) with no receiver, so the getter's
    // inner `this.celsius` runs against the raw snapshot and never records. Only the getter key lands.
    expect(affectedToPathList(first, affected)).toEqual([["fahrenheit"]]);

    // Gating compares each later generation against the recorded snapshot (retrack's `prev` is the
    // wrapped generation). An unrelated-field change leaves the getter's value equal, so it gates closed.
    state.other.n = 2;

    const afterUnrelated = snapshot(state);

    expect(isChanged(first, afterUnrelated, affected, new WeakMap())).toBe(false);

    // A change to the data the getter derives from moves its recomputed value, so it gates open — even
    // though only the getter key recorded, gating is value-based (per-generation recompute), not dependency-based.
    state.celsius = 100;

    const afterData = snapshot(state);

    expect(isChanged(first, afterData, affected, new WeakMap())).toBe(true);
  });
});

// Phase 1.4: the wrapper notification channel (Phase 7 rides it) and the temporary synchronous
// subscription that lets a wrapper call inside mutate join that mutate's owned emission window.
describe("createHandler seam: custom-op propagation and sync subscription", () => {
  const { proxyStateMap } = unstable_getInternalStates();

  it("propagates a captured notifyUpdate's custom op array to a root subscribe, path-prefixed", () => {
    const notifiers = new WeakMap<object, NotifyUpdate>();

    let defaultCreateHandler: CreateHandler;

    unstable_replaceInternalFunction("createHandler", (current) => {
      defaultCreateHandler = current;

      const replacement: CreateHandler = (isInitializing, addPropListener, removePropListener, notifyUpdate) => {
        const handler = current(isInitializing, addPropListener, removePropListener, notifyUpdate);

        return {
          ...handler,
          get(target, prop, receiver) {
            notifiers.set(target, notifyUpdate);

            return Reflect.get(target, prop, receiver);
          },
        };
      };

      return replacement;
    });

    try {
      const root = proxy({ child: { wrapper: 1 } });

      void root.child.wrapper;

      const childTarget = proxyStateMap.get(root.child)![0];
      const notify = notifiers.get(childTarget);

      expect(notify).toBeTypeOf("function");

      const received: Array<unknown> = [];
      const unsubscribe = subscribe(root, (ops) => received.push(...ops), true);

      notify!(["opshot-wrapper", ["wrapper"], { payload: 42 }] as unknown as ValtioOp);

      expect(received).toEqual([["opshot-wrapper", ["child", "wrapper"], { payload: 42 }]]);

      unsubscribe();
    } finally {
      unstable_replaceInternalFunction("createHandler", () => defaultCreateHandler);
    }
  });

  it("adds a sync subscriber without paying the 0->1 cascade when a persistent listener already holds it", () => {
    const child = proxy({ x: 0 });
    const parent = proxy({ child });
    const childState = proxyStateMap.get(child)! as unknown as [object, unknown, AddListener];
    const realAddListener = childState[2];

    let cascadeCount = 0;

    childState[2] = (listener) => {
      cascadeCount += 1;

      return realAddListener(listener);
    };

    try {
      const unsubscribePersistent = subscribe(parent, () => {}, false);

      expect(cascadeCount).toBe(1);

      let syncCalls = 0;
      const syncOps: Array<unknown> = [];
      const unsubscribeSync = subscribe(
        parent,
        (ops) => {
          syncCalls += 1;
          syncOps.push(...ops);
        },
        true,
      );

      expect(cascadeCount).toBe(1);

      child.x = 7;

      // The sync callback fires synchronously inside the write. Ordinary writes carry an empty ops
      // array in valtio 2.3.2 — createOp stays undefined unless unstable_enableOp(true) is called.
      expect(syncCalls).toBe(1);
      expect(syncOps).toEqual([]);

      unsubscribeSync();

      expect(cascadeCount).toBe(1);

      unsubscribePersistent();
    } finally {
      childState[2] = realAddListener;
    }
  });
});

// Phase 1.5: the frozen-plain-object seed gate under raw valtio (no seam installed). Object.freeze
// is shallow, so there is no single "dead region + stale" case: a write to the frozen object's own
// prop throws, while a write to its mutable child lands and shows through the shared reference. The
// Phase 2 boundary supersedes both — canProxy returns false for a frozen object, so it stores by
// reference untracked. See design-architecture.md, "Loud boundary" (frozen auto-ignore).
describe("frozen-object seed gate", () => {
  it("throws on a write to the frozen object's own prop, leaving the snapshot stale", () => {
    const state = proxy<{ frozen: { inner: { x: number } } }>({ frozen: { inner: { x: 0 } } });

    state.frozen = Object.freeze({ inner: { x: 1 } });

    expect(() => {
      state.frozen.inner = { x: 99 };
    }).toThrow(TypeError);

    // The set trap returns true and calls notifyUpdate before the engine enforces the proxy
    // non-writable invariant and throws, so the version bumps — but the write never landed, so the
    // fresh snapshot carries the stale value.
    expect(snapshot(state).frozen).toEqual({ inner: { x: 1 } });
  });

  it("lands a write to the shallow-frozen object's mutable child and shows it through the shared reference", () => {
    const state = proxy<{ frozen: { inner: { x: number } } }>({ frozen: { inner: { x: 0 } } });

    state.frozen = Object.freeze({ inner: { x: 1 } });

    state.frozen.inner.x = 2;

    expect(snapshot(state).frozen.inner.x).toBe(2);
  });
});
