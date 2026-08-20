import { addressOf } from "./address";
import { iterateSlots } from "./iterateSlots";
import { deleteFromStore, translateCursor, type SlotStore } from "./slotStore";

const createStore = (): SlotStore<string> => ({ slots: [], index: {}, count: 0 });

const appendEntry = (store: SlotStore<string>, entry: string): void => {
	store.slots.push(entry);
	store.index[addressOf(entry)] = store.slots.length - 1;
	store.count += 1;
};

const addressOfEntry = (entry: string): string => addressOf(entry);

const resolveEntry = (store: SlotStore<string>, key: string): string | null | undefined => {
	const slot = store.index[addressOf(key)];

	return slot === undefined ? undefined : store.slots[slot];
};

describe("slotStore", () => {
	it("compaction with survivors rebuilds the index onto compacted positions", () => {
		const store = createStore();

		for (const key of ["a", "b", "c", "d"]) appendEntry(store, key);
		for (const key of ["t0", "t1", "t2", "t3"]) appendEntry(store, key);

		expect(deleteFromStore(store, addressOf("t0"), addressOfEntry)).toBe(true);
		expect(deleteFromStore(store, addressOf("t1"), addressOfEntry)).toBe(true);
		expect(deleteFromStore(store, addressOf("t2"), addressOfEntry)).toBe(true);
		expect(deleteFromStore(store, addressOf("t3"), addressOfEntry)).toBe(true);

		expect(store.count).toBe(4);
		expect(store.slots).toEqual(["a", "b", "c", "d"]);
		expect(Object.keys(store.index)).toEqual(["sa", "sb", "sc", "sd"]);

		for (const [key, position] of [
			["a", 0],
			["b", 1],
			["c", 2],
			["d", 3],
		] as const) {
			expect(store.index[addressOf(key)]).toBe(position);
			expect(resolveEntry(store, key)).toBe(key);
		}

		expect(resolveEntry(store, "t0")).toBeUndefined();
		expect(resolveEntry(store, "t3")).toBeUndefined();
	});

	it("slots stay bounded by twice the live size under sustained add and delete churn", () => {
		const store = createStore();
		const liveKeys = ["k0", "k1", "k2", "k3", "k4", "k5", "k6", "k7", "k8", "k9"];

		for (const key of liveKeys) appendEntry(store, key);

		for (let cycle = 0; cycle < 5000; cycle += 1) {
			const added = `transient${cycle}`;

			appendEntry(store, added);
			expect(store.slots.length).toBeLessThanOrEqual(2 * store.count);

			const evictedIndex = cycle % liveKeys.length;
			const evicted = liveKeys[evictedIndex];

			if (evicted === undefined) throw new Error("expected a live key");

			expect(deleteFromStore(store, addressOf(evicted), addressOfEntry)).toBe(true);
			liveKeys[evictedIndex] = added;
			expect(store.slots.length).toBeLessThanOrEqual(2 * store.count);
		}

		expect(store.count).toBe(10);

		for (const key of liveKeys) expect(resolveEntry(store, key)).toBe(key);
	});

	it("delete of an absent address returns false and leaves the store untouched", () => {
		const store = createStore();

		appendEntry(store, "a");
		appendEntry(store, "b");

		const slotsBefore = store.slots;
		const indexBefore = store.index;
		const countBefore = store.count;
		const slotsCopy = [...store.slots];
		const indexCopy = { ...store.index };

		expect(deleteFromStore(store, addressOf("missing"), addressOfEntry)).toBe(false);
		expect(store.slots).toBe(slotsBefore);
		expect(store.index).toBe(indexBefore);
		expect(store.count).toBe(countBefore);
		expect(store.slots).toEqual(slotsCopy);
		expect(store.index).toEqual(indexCopy);
	});

	it("compaction stays correct after an iterator advanced partway and was dropped", () => {
		const store = createStore();

		for (const key of ["a", "b", "c", "d", "e", "f", "g", "h"]) appendEntry(store, key);

		const firstSlots = store.slots;
		const iterator = iterateSlots(() => store.slots);

		expect(iterator.next().value).toBe("a");
		expect(iterator.next().value).toBe("b");

		for (const key of ["b", "d", "f", "h"]) {
			expect(deleteFromStore(store, addressOf(key), addressOfEntry)).toBe(true);
		}

		const afterFirstCompact = store.slots;

		expect(store.slots).toEqual(["a", "c", "e", "g"]);
		expect(translateCursor(firstSlots, 2, afterFirstCompact)).toBe(1);

		for (const key of ["i", "j", "k", "l"]) appendEntry(store, key);
		for (const key of ["a", "c", "e", "g"]) {
			expect(deleteFromStore(store, addressOf(key), addressOfEntry)).toBe(true);
		}

		expect(store.count).toBe(4);
		expect(store.slots).toEqual(["i", "j", "k", "l"]);

		for (const [key, position] of [
			["i", 0],
			["j", 1],
			["k", 2],
			["l", 3],
		] as const) {
			expect(store.index[addressOf(key)]).toBe(position);
			expect(resolveEntry(store, key)).toBe(key);
		}

		expect(translateCursor(firstSlots, 2, store.slots)).toBe(0);
		expect(translateCursor(afterFirstCompact, 1, store.slots)).toBe(0);
		expect(translateCursor(["orphan"], 1, ["other"])).toBe(0);
	});
});
