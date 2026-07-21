import { affectedToPathList, createProxy, getUntracked, isChanged, markToTrack } from "proxy-compare";
import { getVersion, proxy, ref, snapshot, subscribe, unstable_getInternalStates, unstable_replaceInternalFunction, type INTERNAL_Op } from "valtio/vanilla";

// Local aliases for valtio's internal seam signatures, which the package's public types do not export.
type CreateHandler = <T extends object>(
	isInitializing: () => boolean,
	addPropListener: (prop: string | symbol, propValue: unknown) => void,
	removePropListener: (prop: string | symbol) => void,
	notifyUpdate: (op: INTERNAL_Op | undefined) => void,
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

  it("identifies ref() values through unstable_getInternalStates().refSet, including values reached through snapshots", () => {
    const internals = unstable_getInternalStates();

    expect(internals.refSet).toBeInstanceOf(WeakSet);

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
    // snapCache seeds before the property walk, so cyclic proxies are legal input to snapshot().
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

// valtio's set trap ends in Reflect.set(target, prop, value, receiver=proxy), so per ECMAScript every ordinary write completes via the proxy's own defineProperty trap; a counter (not a boolean) survives nested child-proxy-creating sets so only the outermost exit returns the guard to zero.
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

// Reimplements valtio's createSnapshotDefault with one added branch (an own accessor copies as a live getter/setter); the replacement must self-recurse, since the default recurses to child snapshots by its own name.
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

    // proxy-compare's get trap reads via Reflect.get(target, key) with no receiver, so the getter's inner `this.celsius` runs against the raw snapshot and never records -- only the getter key lands.
    expect(affectedToPathList(first, affected)).toEqual([["fahrenheit"]]);

    // An unrelated-field change leaves the getter's recomputed value equal, so isChanged gates closed.
    state.other.n = 2;

    const afterUnrelated = snapshot(state);

    expect(isChanged(first, afterUnrelated, affected, new WeakMap())).toBe(false);

    // A change to the getter's source data moves its recomputed value, so it gates open -- gating is value-based (per-generation recompute), not dependency-based, though only the getter key recorded.
    state.celsius = 100;

    const afterData = snapshot(state);

    expect(isChanged(first, afterData, affected, new WeakMap())).toBe(true);
  });
});

describe("frozen-object seed gate", () => {
  it("throws on a write to the frozen object's own prop, leaving the snapshot stale", () => {
    const state = proxy<{ frozen: { inner: { x: number } } }>({ frozen: { inner: { x: 0 } } });

    state.frozen = Object.freeze({ inner: { x: 1 } });

    expect(() => {
      state.frozen.inner = { x: 99 };
    }).toThrow(TypeError);

    // valtio's set trap returns true and calls notifyUpdate before the engine enforces the non-writable invariant and throws, so the version bumps though the write never landed -- the fresh snapshot carries the stale value.
    expect(snapshot(state).frozen).toEqual({ inner: { x: 1 } });
  });

  it("lands a write to the shallow-frozen object's mutable child and shows it through the shared reference", () => {
    const state = proxy<{ frozen: { inner: { x: number } } }>({ frozen: { inner: { x: 0 } } });

    state.frozen = Object.freeze({ inner: { x: 1 } });

    state.frozen.inner.x = 2;

    expect(snapshot(state).frozen.inner.x).toBe(2);
  });
});

describe("facade and identity probes", () => {
  it("binds prototype methods to a proxied facade and preserves its branded prototype in snapshots", () => {
    interface FacadeProbe {
      count: number;
      increment(): void;
    }

    const brand = Symbol.for("opshot.probe.facade");
    const facadePrototype = {
      increment(this: FacadeProbe) {
        this.count += 1;
      },
    };

    Object.defineProperty(facadePrototype, brand, { value: true });

    const target = Object.assign(Object.create(facadePrototype) as FacadeProbe, { count: 0 });
    const facade = proxy(target);
    const before = snapshot(facade);
    const versionBefore = getVersion(facade);

    if (versionBefore === undefined) throw new Error("facade probe: proxy has no valtio version");

    expect(Object.hasOwn(facade, "increment")).toBe(false);
    expect(Reflect.getPrototypeOf(facade)).toBe(facadePrototype);
    expect(Reflect.getPrototypeOf(before)).toBe(facadePrototype);
    expect(Reflect.get(Reflect.getPrototypeOf(facade)!, brand)).toBe(true);
    expect(Reflect.get(Reflect.getPrototypeOf(before)!, brand)).toBe(true);

    facade.increment();

    const after = snapshot(facade);

    expect(getVersion(facade)).toBeGreaterThan(versionBefore);
    expect(after).not.toBe(before);
    expect(before.count).toBe(0);
    expect(after.count).toBe(1);
  });

  it("carries a non-enumerable property through snapshots and tracks its changes", () => {
    const target = { label: "probe" } as { label: string; epoch: number };

    Object.defineProperty(target, "epoch", {
      value: 0,
      writable: true,
      enumerable: false,
      configurable: true,
    });

    const state = proxy(target);
    const before = snapshot(state);
    const versionBefore = getVersion(state);

    if (versionBefore === undefined) throw new Error("ride-along probe: proxy has no valtio version");

    expect(Reflect.ownKeys(before)).toContain("epoch");
    expect(Object.getOwnPropertyDescriptor(before, "epoch")?.enumerable).toBe(false);

    const affected = new WeakMap<object, unknown>();
    const wrapped = createProxy(before, affected, new WeakMap(), new WeakMap());

    expect(wrapped.epoch).toBe(0);
    expect(affectedToPathList(before, affected)).toContainEqual(["epoch"]);

    state.epoch = 1;

    const after = snapshot(state);

    expect(getVersion(state)).toBeGreaterThan(versionBefore);
    expect(Reflect.ownKeys(after)).toContain("epoch");
    expect(after.epoch).toBe(1);
    expect(isChanged(before, after, affected, new WeakMap())).toBe(true);
  });

  it("binds prototype method calls to tracking wrappers so reads through this are recorded", () => {
    interface FacadeProbe {
      data: Array<number>;
      first(): number;
    }

    const facadePrototype = {
      first(this: FacadeProbe) {
        return this.data[0]!;
      },
    };
    const target = Object.assign(Object.create(facadePrototype) as FacadeProbe, { data: [7, 8] });
    const snap = snapshot(proxy(target));
    const affected = new WeakMap<object, unknown>();
    const wrapped = createProxy(snap, affected, new WeakMap(), new WeakMap());

    expect(wrapped.first()).toBe(7);
    expect(affectedToPathList(snap, affected)).toContainEqual(["data", "0"]);
  });

  it("unwraps a proxy-compare tracking wrapper to its exact snapshot copy", () => {
    const snap = snapshot(proxy({ value: 1 }));
    const wrapped = createProxy(snap, new WeakMap(), new WeakMap(), new WeakMap());

    expect(getUntracked(wrapped)).toBe(snap);
  });

  it("seeds a copy registry for every nested snapshot copy during the snapshot walk", () => {
    const { refSet, proxyStateMap } = unstable_getInternalStates();
    const copyRegistry = new WeakMap<object, object>();
    const copyCache = new WeakMap<object, [number, object]>();

    const createRegisteredSnapshot = <T extends object>(target: T, version: number): T => {
      const cached = copyCache.get(target);

      if (cached?.[0] === version) return cached[1] as T;

      const copy: object = Array.isArray(target) ? [] : Object.create(Reflect.getPrototypeOf(target) as object | null);

      markToTrack(copy, true);
      copyCache.set(target, [version, copy]);
      copyRegistry.set(copy, target);

      for (const key of Reflect.ownKeys(target)) {
        if (Object.getOwnPropertyDescriptor(copy, key)) continue;

        const descriptor = Reflect.getOwnPropertyDescriptor(target, key);

        if (!descriptor) continue;

        if (descriptor.get || descriptor.set) {
          Object.defineProperty(copy, key, {
            get: descriptor.get,
            set: descriptor.set,
            enumerable: descriptor.enumerable,
            configurable: true,
          });

          continue;
        }

        const value: unknown = Reflect.get(target, key);
        const copyDescriptor: PropertyDescriptor = { value, enumerable: descriptor.enumerable, configurable: true };

        if (typeof value === "object" && value !== null) {
          if (refSet.has(value)) {
            markToTrack(value, false);
          } else {
            const childState = proxyStateMap.get(value);

            if (childState) copyDescriptor.value = createRegisteredSnapshot(childState[0], childState[1]());
          }
        }

        Object.defineProperty(copy, key, copyDescriptor);
      }

      return copy as T;
    };

    const state = proxy({ outer: { inner: { value: 1 } } });
    const rootState = proxyStateMap.get(state);
    const outerState = proxyStateMap.get(state.outer);
    const innerState = proxyStateMap.get(state.outer.inner);

    if (!rootState || !outerState || !innerState) throw new Error("registry probe: expected proxy state at every level");

    const registered = createRegisteredSnapshot(rootState[0], rootState[1]()) as {
      outer: { inner: { value: number } };
    };

    expect(copyRegistry.get(registered)).toBe(rootState[0]);
    expect(copyRegistry.get(registered.outer)).toBe(outerState[0]);
    expect(copyRegistry.get(registered.outer.inner)).toBe(innerState[0]);
  });

  it("reuses a detached raw target's cached child proxy when the target is reattached", () => {
    const target = { value: 1 };
    const state = proxy<{ item?: { value: number } }>({ item: target });
    const firstChildProxy = state.item;

    delete state.item;

    expect(snapshot(state).item).toBeUndefined();

    state.item = target;

    const reattached = state.item;

    if (!firstChildProxy || !reattached) throw new Error("reattach probe: expected child proxy");

    expect(reattached).toBe(firstChildProxy);

    reattached.value = 9;

    expect(target.value).toBe(9);
    expect(snapshot(state).item?.value).toBe(9);
  });

  it("shares every existing array element across the snapshot generated by a tail push", () => {
    const state = proxy({ items: [{ value: 1 }, { value: 2 }] });
    const before = snapshot(state).items;

    state.items.push({ value: 3 });

    const after = snapshot(state).items;

    expect(after).toHaveLength(before.length + 1);

    for (const [index, item] of before.entries()) expect(Object.is(after[index], item)).toBe(true);
  });
});

describe("opshot boundary dead-region guard", () => {
  let targetRegistry: unknown;
  let identityTokenRegistry: unknown;
  let reusedPreInstallSnapshot = false;
  let donatePreInstallSnapshot: (() => void) | undefined;
  let restoreCanProxy: (() => void) | undefined;
  let restoreCreateHandler: (() => void) | undefined;
  let restoreCreateSnapshot: (() => void) | undefined;

  beforeAll(async () => {
    unstable_replaceInternalFunction("canProxy", (current) => {
      restoreCanProxy = () => {
        unstable_replaceInternalFunction("canProxy", () => current);
      };

      return current;
    });
    unstable_replaceInternalFunction("createHandler", (current) => {
      restoreCreateHandler = () => {
        unstable_replaceInternalFunction("createHandler", () => current);
      };

      return current;
    });
    unstable_replaceInternalFunction("createSnapshot", (current) => {
      restoreCreateSnapshot = () => {
        unstable_replaceInternalFunction("createSnapshot", () => current);
      };

      return current;
    });

    vi.resetModules();

    class RejectingWeakMap extends WeakMap<object, object> {
      override set(_key: object, _value: object): this {
        throw new Error("registry subclass must not be used");
      }
    }

    for (const key of [Symbol.for("opshot.targets"), Symbol.for("opshot.identityTokens")]) {
      if (!Reflect.defineProperty(globalThis, key, { value: new RejectingWeakMap(), configurable: true })) {
        throw new Error("identity registry test: could not seed the global registry key");
      }
    }

    const { proxy: freshProxy, snapshot: freshSnapshot } = await import("valtio/vanilla");
    const source = freshProxy({ value: 1 });
    const preInstallSnapshot = freshSnapshot(source);
    const { createState } = await import("../createState");
    const reused = freshSnapshot(source);
    const destination = createState<{ item: unknown }>({ item: null });

    targetRegistry = Reflect.get(globalThis, Symbol.for("opshot.targets"));
    identityTokenRegistry = Reflect.get(globalThis, Symbol.for("opshot.identityTokens"));
    reusedPreInstallSnapshot = reused === preInstallSnapshot;
    donatePreInstallSnapshot = () => {
      destination.mutate((mutable) => {
        mutable.item = preInstallSnapshot;
      });
    };
  });

  afterAll(() => {
    restoreCreateSnapshot?.();
    restoreCreateHandler?.();
    restoreCanProxy?.();
  });

  it("rejects WeakMap subclasses and installs bare global registries", () => {
    expect(targetRegistry).toBeInstanceOf(WeakMap);
    expect(identityTokenRegistry).toBeInstanceOf(WeakMap);

    if (!(targetRegistry instanceof WeakMap) || !(identityTokenRegistry instanceof WeakMap)) {
      throw new Error("identity registry test: expected WeakMap registries");
    }

    expect(Object.getPrototypeOf(targetRegistry)).toBe(WeakMap.prototype);
    expect(Object.getPrototypeOf(identityTokenRegistry)).toBe(WeakMap.prototype);
  });

  it("registers a reused pre-install snapshot before rejecting its donation", () => {
    expect(reusedPreInstallSnapshot).toBe(true);

    if (!donatePreInstallSnapshot) throw new Error("identity registry test: donation probe was not initialized");

    expect(donatePreInstallSnapshot).toThrow("a snapshot generation is a read-view, and assigning it creates a dead region");
  });
});
