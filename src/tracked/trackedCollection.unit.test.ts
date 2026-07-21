import { createProxy } from "proxy-compare";

import { createState } from "../createState";
import { getCollectionIndex } from "./trackedCollection";
import { getTrackedMapData, setTrackedMapData, TrackedMap } from "./trackedMap";
import { getTrackedSetData, setTrackedSetData, TrackedSet } from "./trackedSet";

describe("tracked collection index", () => {
	it("updates one valid derived index incrementally across facade writes", () => {
		const map = new TrackedMap<string, number>();
		const mapIndex = getCollectionIndex(getTrackedMapData(map));
		const set = new TrackedSet<number>();
		const setIndex = getCollectionIndex(getTrackedSetData(set));

		for (let value = 0; value < 100; value++) {
			map.set(String(value), value);
			set.add(value);

			expect(getCollectionIndex(getTrackedMapData(map))).toBe(mapIndex);
			expect(getCollectionIndex(getTrackedSetData(set))).toBe(setIndex);
		}

		expect(mapIndex.slots.size).toBe(100);
		expect(setIndex.slots.size).toBe(100);
	});

	it("updates one index incrementally across separately snapshotted mutates", () => {
		const state = createState({ map: new TrackedMap<string, number>() });
		let index: ReturnType<typeof getCollectionIndex> | undefined;

		for (let value = 0; value < 100; value++) {
			state.mutate((mutable) => {
				const before = getCollectionIndex(getTrackedMapData(mutable.map));

				if (index !== undefined) expect(before).toBe(index);

				mutable.map.set(String(value), value);

				const after = getCollectionIndex(getTrackedMapData(mutable.map));

				expect(after).toBe(before);
				index = after;
			});
		}

		expect(index?.slots.size).toBe(100);
	});

	it("rebuilds after a direct proxy-backing write advances the backing generation", () => {
		const state = createState({ map: new TrackedMap<string, number>([["a", 1]]) });

		state.mutate((mutable) => {
			const before = getCollectionIndex(getTrackedMapData(mutable.map));

			getTrackedMapData(mutable.map)[0] = ["b", 2];

			const after = getCollectionIndex(getTrackedMapData(mutable.map));

			expect(after).not.toBe(before);
			expect(after.slots.has("a")).toBe(false);
			expect(after.slots.get("b")).toBe(0);
		});
	});

	it("keeps indexes valid across nested map-value and set-member writes", () => {
		const map = new TrackedMap<string, { field: number }>([["key", { field: 1 }]]);
		const mapBefore = getCollectionIndex(getTrackedMapData(map));
		const mapValue = map.get("key");
		const set = new TrackedSet<{ field: number }>([{ field: 1 }]);
		const setBefore = getCollectionIndex(getTrackedSetData(set));
		const setMember = [...set][0];

		if (mapValue === undefined || setMember === undefined) throw new Error("the collection value was not found");

		mapValue.field = 2;
		setMember.field = 2;

		expect(getCollectionIndex(getTrackedMapData(map))).toBe(mapBefore);
		expect(getCollectionIndex(getTrackedSetData(set))).toBe(setBefore);
		expect(map.has("key")).toBe(true);
		expect(set.has(setMember)).toBe(true);
	});

	it("does not cache untracked replacement backing", () => {
		const map = new TrackedMap<string, number>();
		const set = new TrackedSet<number>();

		setTrackedMapData(map, [["a", 1]]);
		setTrackedSetData(set, [[1]]);

		expect(map.has("a")).toBe(true);
		expect(set.has(1)).toBe(true);

		getTrackedMapData(map)[0] = ["b", 2];
		getTrackedSetData(set)[0] = [2];

		expect(map.has("a")).toBe(false);
		expect(map.get("b")).toBe(2);
		expect(set.has(1)).toBe(false);
		expect(set.has(2)).toBe(true);
	});

	it("shares one index across mutable, snapshot, and tracking handles and unchanged-membership generations", () => {
		const state = createState({ map: new TrackedMap<string, { field: number }>([["a", { field: 1 }]]) });
		let mutableIndex: ReturnType<typeof getCollectionIndex> | undefined;

		state.mutate((mutable) => {
			mutableIndex = getCollectionIndex(getTrackedMapData(mutable.map));
		});

		const firstSnapshot = state.op.unwrap();
		const snapshotIndex = getCollectionIndex(getTrackedMapData(firstSnapshot.map));
		const tracked = createProxy(firstSnapshot, new WeakMap(), new WeakMap(), new WeakMap());
		const trackedIndex = getCollectionIndex(getTrackedMapData(tracked.map));

		expect(snapshotIndex).toBe(mutableIndex);
		expect(trackedIndex).toBe(mutableIndex);

		state.mutate((mutable) => {
			const value = mutable.map.get("a");

			if (value === undefined) throw new Error("the map value was not found");

			value.field = 2;
		});

		const secondSnapshot = state.op.unwrap();

		expect(getTrackedMapData(secondSnapshot.map)).not.toBe(getTrackedMapData(firstSnapshot.map));
		expect(getCollectionIndex(getTrackedMapData(secondSnapshot.map))).toBe(mutableIndex);

		state.mutate((mutable) => {
			expect(getCollectionIndex(getTrackedMapData(mutable.map))).toBe(mutableIndex);
		});
	});

	it("keeps old snapshot membership bound to its generation", () => {
		const state = createState({ map: new TrackedMap<string, number>([["a", 1]]) });
		const before = state.op.unwrap();

		expect(before.map.has("a")).toBe(true);

		state.mutate((mutable) => {
			mutable.map.delete("a");
			mutable.map.set("b", 2);
		});

		const after = state.op.unwrap();

		expect(before.map.size).toBe(1);
		expect(before.map.has("a")).toBe(true);
		expect(before.map.has("b")).toBe(false);
		expect(before.map.get("a")).toBe(1);
		expect([...before.map]).toEqual([["a", 1]]);
		expect(after.map.size).toBe(1);
		expect(after.map.has("a")).toBe(false);
		expect(after.map.has("b")).toBe(true);
		expect(after.map.get("b")).toBe(2);
	});

	it("installs direct-write tracking when the collection module loads first", async () => {
		vi.resetModules();

		const { getTrackedMapData: getFreshTrackedMapData, TrackedMap: FreshTrackedMap } = await import("./trackedMap");
		const map = new FreshTrackedMap<string, number>([["a", 1]]);

		expect(map.has("a")).toBe(true);

		getFreshTrackedMapData(map)[0] = ["b", 2];

		expect(map.has("a")).toBe(false);
		expect(map.get("b")).toBe(2);
	});

	it("removes undefined identities from map and set indexes", () => {
		const map = new TrackedMap<undefined, number>([[undefined, 1]]);
		const set = new TrackedSet<undefined>([undefined]);

		expect(map.delete(undefined)).toBe(true);
		expect(map.has(undefined)).toBe(false);
		expect(map.size).toBe(0);
		expect(set.delete(undefined)).toBe(true);
		expect(set.has(undefined)).toBe(false);
		expect(set.size).toBe(0);
	});
});
