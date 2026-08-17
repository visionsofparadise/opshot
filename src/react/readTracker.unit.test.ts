import { describe, expect, it } from "vitest";
import { proxy, unstable_getInternalStates } from "valtio/vanilla";

import { ignore } from "../ignore";
import { installBoundary } from "../valtio/boundary";
import { createReadTracker, isReadProxy, readsIntersectDirty } from "./readTracker";
import { peelReadProxy } from "../peelReadProxy";
import type { DirtyIndex } from "../handle";

const { proxyStateMap } = unstable_getInternalStates();

const rawTargetOf = (writeProxy: object): object => proxyStateMap.get(writeProxy)?.[0] ?? writeProxy;

const emptyDirty = (): DirtyIndex => ({ edges: new WeakMap(), nodes: new WeakSet() });

const edgesDirty = (node: object, keys: ReadonlyArray<string | symbol>): DirtyIndex => {
	const dirty = emptyDirty();

	dirty.edges.set(rawTargetOf(node), new Set(keys));

	return dirty;
};

installBoundary();

const createLive = <T extends object>(properties: T): T => proxy(properties);

describe("ReadTracker", () => {
	it("returns live values, forwards set/delete, and preserves read-your-writes", () => {
		const state = createLive({ count: 0, nested: { value: 1 } });
		const readTracker = createReadTracker();
		const readProxy = readTracker.wrap(state);

		expect(readProxy.count).toBe(0);
		readProxy.count += 1;
		expect(readProxy.count).toBe(1);
		expect(state.count).toBe(1);
		readProxy.nested.value = 2;
		expect(readProxy.nested.value).toBe(2);
		delete (readProxy as { count?: number }).count;
		expect("count" in state).toBe(false);
	});

	it("is a registered readProxy peelable by peelReadProxy", () => {
		const state = createLive({ count: 0 });
		const readTracker = createReadTracker();
		const readProxy = readTracker.wrap(state);

		expect(isReadProxy(readProxy)).toBe(true);
		expect(peelReadProxy(readProxy)).toBe(state);
		expect(isReadProxy(state)).toBe(false);
	});

	it("resets read lifecycle without clearing readProxy identity", () => {
		const state = createLive({ nested: { value: 1 } });
		const readTracker = createReadTracker();
		const first = readTracker.wrap(state);
		const nestedFirst = first.nested;

		void nestedFirst.value;
		readTracker.resetReads();

		const second = readTracker.wrap(state);
		const nestedSecond = second.nested;

		expect(second).toBe(first);
		expect(nestedSecond).toBe(nestedFirst);
	});

	it("remints a readProxy whose node's version moved and retains untouched siblings", () => {
		const state = createLive({ left: { value: 1 }, right: { value: 2 } });
		const readTracker = createReadTracker();
		const readProxy = readTracker.wrap(state);
		const left = readProxy.left;
		const right = readProxy.right;

		void left.value;
		void right.value;

		state.left.value = 9;

		const next = readTracker.wrap(state);

		expect(next.left).not.toBe(left);
		expect(next.right).toBe(right);
	});

	it("passes through ignore and frozen leaves without wrapping", () => {
		const ignored = ignore({ secret: 1 });
		const frozen = Object.freeze({ n: 1 });
		const state = createLive({ ignored, frozen });
		const readTracker = createReadTracker();
		const readProxy = readTracker.wrap(state);

		expect(readProxy.ignored).toBe(ignored);
		expect(readProxy.frozen).toBe(frozen);
		expect(isReadProxy(readProxy.ignored)).toBe(false);
	});

	it("binds clean-class prototype methods to the readProxy so interiors record", () => {
		class Counter {
			count = 0;

			bump(): number {
				this.count += 1;

				return this.count;
			}
		}

		const state = createLive(new Counter());
		const readTracker = createReadTracker();
		const readProxy = readTracker.wrap(state);

		const first = readProxy.bump;
		const second = readProxy.bump;

		expect(first).toBe(second);
		expect(first()).toBe(1);
		expect(state.count).toBe(1);
		expect(readsIntersectDirty(readTracker, edgesDirty(state, ["count"]))).toBe(true);
	});

	it("records a prototype-method lookup as that key, not instance fields", () => {
		class Counter {
			count = 0;

			bump(): number {
				this.count += 1;

				return this.count;
			}
		}

		const state = createLive(new Counter());
		const readTracker = createReadTracker();
		const readProxy = readTracker.wrap(state);

		void readProxy.bump;
		expect(readsIntersectDirty(readTracker, edgesDirty(state, ["count"]))).toBe(false);
		expect(readsIntersectDirty(readTracker, edgesDirty(state, ["bump"]))).toBe(true);
	});

	it("records a nested object read only through a prototype method, so unread siblings stay silent", () => {
		class Counter {
			count = 0;

			other = 0;

			read(): number {
				return this.count;
			}
		}

		const state = createLive({ counter: new Counter() });
		const readTracker = createReadTracker();
		const readProxy = readTracker.wrap(state);

		void readProxy.counter.read;

		expect(readsIntersectDirty(readTracker, edgesDirty(state.counter, ["other"]))).toBe(false);
		expect(readsIntersectDirty(readTracker, edgesDirty(state.counter, ["read"]))).toBe(true);
	});

	it("throws when wrap receives a non-proxy", () => {
		const readTracker = createReadTracker();

		expect(() => readTracker.wrap({ count: 0 })).toThrow("opshot: ReadTracker.wrap requires a write proxy");
	});

	it("wrap with no mutation returns the same root reference", () => {
		const state = createLive({ count: 0 });
		const readTracker = createReadTracker();
		const first = readTracker.wrap(state);
		const second = readTracker.wrap(state);

		expect(second).toBe(first);
	});

	it("remints the root readProxy after a read field mutates", () => {
		const state = createLive({ count: 0 });
		const readTracker = createReadTracker();
		const first = readTracker.wrap(state);

		void first.count;
		state.count = 1;

		expect(readTracker.wrap(state)).not.toBe(first);
	});

	it("remints the root readProxy after an unread field mutates", () => {
		const state = createLive({ count: 0, other: 0 });
		const readTracker = createReadTracker();
		const first = readTracker.wrap(state);

		void first.count;
		state.other = 1;

		expect(readTracker.wrap(state)).not.toBe(first);
	});

	it("keeps a nested readProxy whose subtree did not change across a root-level change", () => {
		const state = createLive({ other: 0, nested: { value: 1 } });
		const readTracker = createReadTracker();
		const first = readTracker.wrap(state);
		const nested = first.nested;

		void first.other;
		void nested.value;

		state.other = 1;

		const next = readTracker.wrap(state);

		expect(next).not.toBe(first);
		expect(next.nested).toBe(nested);
	});

	it("releases every partition on dispose", async () => {
		const readTracker = createReadTracker();
		const documents = Array.from({ length: 20 }, (_, index) => createLive({ id: index, body: { text: "x" } }));
		const retained = documents.map((document) => {
			const readProxy = readTracker.wrap(document);

			void readProxy.id;
			void readProxy.body.text;

			return readProxy;
		});

		readTracker.dispose();
		await Promise.resolve();

		for (const document of documents) {
			expect(readsIntersectDirty(readTracker, edgesDirty(document, ["id"]))).toBe(false);
		}

		for (const readProxy of retained) {
			expect(isReadProxy(readProxy)).toBe(true);
			expect(readProxy.body.text).toBe("x");
		}
	});

	it("keeps its partitions when a dispose is retained before it settles", async () => {
		const readTracker = createReadTracker();
		const state = createLive({ shown: 0, hidden: 0 });
		const readProxy = readTracker.wrap(state);

		void readProxy.shown;

		readTracker.dispose();
		readTracker.retain();

		await Promise.resolve();

		expect(readsIntersectDirty(readTracker, edgesDirty(state, ["shown"]))).toBe(true);
	});

	it("stops reporting reads once a dispose has settled", async () => {
		const readTracker = createReadTracker();
		const state = createLive({ shown: 0 });
		const readProxy = readTracker.wrap(state);

		void readProxy.shown;

		readTracker.dispose();

		await Promise.resolve();

		expect(readsIntersectDirty(readTracker, edgesDirty(state, ["shown"]))).toBe(false);
	});
});

describe("readsIntersectDirty", () => {
	it("hits a recorded key and misses a sibling", () => {
		const state = createLive({ a: 1, b: 2 });
		const readTracker = createReadTracker();
		const readProxy = readTracker.wrap(state);

		void readProxy.a;

		const dirty = emptyDirty();
		const raw = rawTargetOf(state);

		dirty.edges.set(raw, new Set(["b"]));
		expect(readsIntersectDirty(readTracker, dirty)).toBe(false);

		dirty.edges.set(raw, new Set(["a"]));
		expect(readsIntersectDirty(readTracker, dirty)).toBe(true);
	});

	it("uses the node flag for ownKeys", () => {
		const state = createLive({ a: 1 });
		const readTracker = createReadTracker();
		const readProxy = readTracker.wrap(state);

		void Reflect.ownKeys(readProxy);

		const dirty = emptyDirty();
		const raw = rawTargetOf(state);

		dirty.edges.set(raw, new Set(["a"]));
		expect(readsIntersectDirty(readTracker, dirty)).toBe(false);

		dirty.nodes.add(raw);
		expect(readsIntersectDirty(readTracker, dirty)).toBe(true);
	});

	it("uses the node flag for an identity-only nested read", () => {
		const state = createLive({ box: { n: 1 }, other: { n: 1 } });
		const readTracker = createReadTracker();
		const readProxy = readTracker.wrap(state);

		void readProxy.box;

		const dirty = emptyDirty();

		dirty.nodes.add(rawTargetOf(state.other));
		expect(readsIntersectDirty(readTracker, dirty)).toBe(false);

		dirty.nodes.add(rawTargetOf(state.box));
		expect(readsIntersectDirty(readTracker, dirty)).toBe(true);
	});
});
