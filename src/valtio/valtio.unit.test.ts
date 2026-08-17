import { createProxy, getUntracked } from "proxy-compare";
import { getVersion, proxy, snapshot, subscribe, unstable_replaceInternalFunction } from "valtio/vanilla";

type CreateSnapshot = <T extends object>(target: T, version: number) => T;

describe("valtio assumptions", () => {
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

	it("moves a node's version exactly when snapshot mints a fresh object for it", () => {
		const state = proxy({ left: { value: 1 }, right: { value: 2 } });
		const left = state.left;
		const right = state.right;

		const first = snapshot(state);
		const versions = { root: getVersion(state), left: getVersion(left), right: getVersion(right) };

		expect(snapshot(state)).toBe(first);
		expect(getVersion(state)).toBe(versions.root);

		state.left.value = 10;

		const second = snapshot(state);

		expect(second).not.toBe(first);
		expect(second.left).not.toBe(first.left);
		expect(second.right).toBe(first.right);

		expect(getVersion(state)).not.toBe(versions.root);
		expect(getVersion(left)).not.toBe(versions.left);
		expect(getVersion(right)).toBe(versions.right);

		const afterLeft = { root: getVersion(state), left: getVersion(left) };

		state.right.value = 20;

		const third = snapshot(state);

		expect(third.right).not.toBe(second.right);
		expect(third.left).toBe(second.left);

		expect(getVersion(state)).not.toBe(afterLeft.root);
		expect(getVersion(left)).toBe(afterLeft.left);
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

	it("uses the installed createSnapshot replacement when snapshot() is called", () => {
		const marker = {};
		let previous: CreateSnapshot | undefined;

		try {
			unstable_replaceInternalFunction("createSnapshot", (current) => {
				previous = current;

				return <T extends object>(_target: T, _version: number): T => marker as T;
			});

			expect(snapshot(proxy({ n: 1 }))).toBe(marker);
		} finally {
			if (previous !== undefined) {
				const restore = previous;

				unstable_replaceInternalFunction("createSnapshot", () => restore);
			}
		}
	});
});

describe("canProxy seam", () => {
	let defaultCanProxy: (value: unknown) => boolean;

	beforeAll(() => {
		unstable_replaceInternalFunction("canProxy", (current) => {
			defaultCanProxy = current;

			return (value) => {
				if (typeof value !== "object" || value === null) return current(value);
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

	it("replays only writable data properties, so a value behind a non-writable one never reaches canProxy", () => {
		const nonWritable = new Map([["k", "v"]]);
		const nonWritableBase: Record<string, unknown> = {};

		Object.defineProperty(nonWritableBase, "held", {
			value: nonWritable,
			enumerable: true,
			writable: false,
			configurable: true,
		});

		const state = proxy(nonWritableBase);

		expect(state.held).toBe(nonWritable);

		const writableBase: Record<string, unknown> = {};

		Object.defineProperty(writableBase, "held", {
			value: new Map([["k", "v"]]),
			enumerable: true,
			writable: true,
			configurable: true,
		});

		expect(() => proxy(writableBase)).toThrow("canProxy probe: Map rejected");
	});
});

describe("canProxy seam restored", () => {
	it("proxies a Map again once the captured default is wrapped back", () => {
		const state = proxy({ m: new Map() });

		expect(state.m).toBeInstanceOf(Map);
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
	it("unwraps a proxy-compare tracking wrapper to its exact snapshot copy", () => {
		const snap = snapshot(proxy({ value: 1 }));
		const wrapped = createProxy(snap, new WeakMap(), new WeakMap(), new WeakMap());

		expect(getUntracked(wrapped)).toBe(snap);
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

		const { proxy: freshProxy, snapshot: freshSnapshot } = await import("valtio/vanilla");
		const source = freshProxy({ value: 1 });
		const preInstallSnapshot = freshSnapshot(source);
		const { createMutableState } = await import("../createMutableState");
		const { transact } = await import("../transact/transact");
		const destination = createMutableState<{ item: unknown }>({ item: null });
		const reused = freshSnapshot(source);

		reusedPreInstallSnapshot = reused === preInstallSnapshot;
		donatePreInstallSnapshot = () => {
			transact(destination, () => {
				destination.item = preInstallSnapshot;
			});
		};
	});

	afterAll(() => {
		restoreCreateSnapshot?.();
		restoreCreateHandler?.();
		restoreCanProxy?.();
	});

	it("registers a reused pre-install snapshot before rejecting its donation", () => {
		expect(reusedPreInstallSnapshot).toBe(true);

		if (!donatePreInstallSnapshot) throw new Error("identity registry test: donation probe was not initialized");

		expect(donatePreInstallSnapshot).toThrow(
			"a snapshot generation is a read-view, and assigning it creates a dead region",
		);
	});
});
