import { describe, expect, it } from "vitest";
import { proxy, unstable_getInternalStates } from "valtio/vanilla";

import { createMutableState } from "../createMutableState";
import type { DirtyIndex } from "../handle";
import { ignore } from "../ignore";
import { installBoundary } from "../valtio/boundary";
import { createReadTracker, isReadProxy, readsIntersectDirty } from "./readTracker";

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
	it("passes through ignore and frozen leaves without wrapping", () => {
		const ignored = { secret: 1 };
		const frozen = Object.freeze({ n: 1 });
		const state = createMutableState({ ignored: ignore(ignored), frozen });
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

		expect(readProxy.bump()).toBe(1);
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
});
