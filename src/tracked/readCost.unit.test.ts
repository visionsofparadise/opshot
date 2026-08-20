import { unstable_getInternalStates } from "valtio/vanilla";

import { createMutableState } from "../createMutableState";
import type { DirtyIndex } from "../handle";
import { createReadTracker, readsIntersectDirty, type ReadTracker } from "../react/readTracker";
import { addressOf } from "./address";
import { TrackedDate } from "./trackedDate";
import { TrackedMap } from "./trackedMap";
import { TrackedSet } from "./trackedSet";

const { proxyStateMap } = unstable_getInternalStates();

const rawTargetOf = (writeProxy: object): object => proxyStateMap.get(writeProxy)?.[0] ?? writeProxy;

const emptyDirty = (): DirtyIndex => ({ edges: new WeakMap(), nodes: new WeakSet() });

const edgesDirty = (node: object, keys: ReadonlyArray<string | symbol>): DirtyIndex => {
	const dirty = emptyDirty();

	dirty.edges.set(rawTargetOf(node), new Set(keys));

	return dirty;
};

const intersectingCount = (tracker: ReadTracker, node: object, keys: ReadonlyArray<string>): number => {
	let count = 0;

	for (const key of keys) {
		if (readsIntersectDirty(tracker, edgesDirty(node, [key]))) count += 1;
	}

	return count;
};

const slotKeysOf = (slots: { length: number }): Array<string> =>
	Array.from({ length: slots.length }, (_, index) => String(index));

type CollectionStore = {
	slots: Array<unknown>;
	index: Record<string, number>;
};

const storeOf = (collection: object): CollectionStore => collection as unknown as CollectionStore;

const filledMap = (size: number): TrackedMap<string, number> => {
	const map = new TrackedMap<string, number>();

	for (let index = 0; index < size; index += 1) map.set(`k${index}`, index);

	return map;
};

const filledSet = (size: number): TrackedSet<string> => {
	const set = new TrackedSet<string>();

	for (let index = 0; index < size; index += 1) set.add(`k${index}`);

	return set;
};

describe("facade read costs", () => {
	it("TrackedMap.get intersects the index and the addressed slot only, identically at 10 and 100 members", () => {
		const readsOf = (size: number) => {
			const state = createMutableState({ map: filledMap(size) });
			const tracker = createReadTracker();
			const readProxy = tracker.wrap(state);
			const key = "k3";

			expect(readProxy.map.get(key)).toBe(3);

			const store = storeOf(state.map);
			const address = addressOf(key);
			const slot = store.index[address];

			if (slot === undefined) throw new Error("expected the looked-up key to occupy a slot");

			return {
				indexHits: intersectingCount(tracker, store.index, Object.keys(store.index)),
				slotHits: intersectingCount(tracker, store.slots, slotKeysOf(store.slots)),
				addressedIndex: readsIntersectDirty(tracker, edgesDirty(store.index, [address])),
				addressedSlot: readsIntersectDirty(tracker, edgesDirty(store.slots, [String(slot)])),
				otherIndex: readsIntersectDirty(tracker, edgesDirty(store.index, [addressOf("k0")])),
				otherSlot: readsIntersectDirty(tracker, edgesDirty(store.slots, ["0"])),
			};
		};

		const atTen = readsOf(10);
		const atHundred = readsOf(100);

		expect(atTen).toEqual({
			indexHits: 1,
			slotHits: 1,
			addressedIndex: true,
			addressedSlot: true,
			otherIndex: false,
			otherSlot: false,
		});
		expect(atHundred).toEqual(atTen);
	});

	it("TrackedSet.has intersects the addressed index entry only, identically at 10 and 100 members", () => {
		const readsOf = (size: number) => {
			const state = createMutableState({ set: filledSet(size) });
			const tracker = createReadTracker();
			const readProxy = tracker.wrap(state);
			const key = "k3";

			expect(readProxy.set.has(key)).toBe(true);

			const store = storeOf(state.set);
			const address = addressOf(key);

			return {
				indexHits: intersectingCount(tracker, store.index, Object.keys(store.index)),
				slotHits: intersectingCount(tracker, store.slots, slotKeysOf(store.slots)),
				addressedIndex: readsIntersectDirty(tracker, edgesDirty(store.index, [address])),
				otherIndex: readsIntersectDirty(tracker, edgesDirty(store.index, [addressOf("k0")])),
			};
		};

		const atTen = readsOf(10);
		const atHundred = readsOf(100);

		expect(atTen).toEqual({
			indexHits: 1,
			slotHits: 0,
			addressedIndex: true,
			otherIndex: false,
		});
		expect(atHundred).toEqual(atTen);
	});

	it("TrackedDate.getTime touches epochMs only", () => {
		const state = createMutableState({ when: new TrackedDate(0), tick: 1 });
		const tracker = createReadTracker();
		const readProxy = tracker.wrap(state);

		expect(readProxy.when.getTime()).toBe(0);

		expect(readsIntersectDirty(tracker, edgesDirty(state.when, ["epochMs"]))).toBe(true);
		expect(readsIntersectDirty(tracker, edgesDirty(state.when, ["slots"]))).toBe(false);
		expect(readsIntersectDirty(tracker, edgesDirty(state.when, ["index"]))).toBe(false);
		expect(readsIntersectDirty(tracker, edgesDirty(state, ["tick"]))).toBe(false);
	});

	it("iteration's touched-slot count equals the visited count", () => {
		const state = createMutableState({ map: filledMap(10) });
		const tracker = createReadTracker();
		const readProxy = tracker.wrap(state);
		const iterator = readProxy.map.entries();
		let visited = 0;

		expect(iterator.next().done).toBe(false);
		visited += 1;
		expect(iterator.next().done).toBe(false);
		visited += 1;
		expect(iterator.next().done).toBe(false);
		visited += 1;

		const store = storeOf(state.map);
		const slotHits = intersectingCount(tracker, store.slots, slotKeysOf(store.slots));

		expect(visited).toBe(3);
		expect(slotHits).toBe(visited);
		expect(readsIntersectDirty(tracker, edgesDirty(store.slots, ["0"]))).toBe(true);
		expect(readsIntersectDirty(tracker, edgesDirty(store.slots, ["2"]))).toBe(true);
		expect(readsIntersectDirty(tracker, edgesDirty(store.slots, ["3"]))).toBe(false);
		expect(readsIntersectDirty(tracker, edgesDirty(store.slots, ["9"]))).toBe(false);
	});
});
