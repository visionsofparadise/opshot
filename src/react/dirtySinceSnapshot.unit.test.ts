import { snapshot, unstable_getInternalStates } from "valtio/vanilla";

import { createMutableState } from "../createMutableState";
import { handleOf } from "../handle";
import { copyOccupancyTables } from "../occupancy";
import { subscribe } from "../subscribe";
import { dirtySinceSnapshot } from "./dirtySinceSnapshot";
import { createReadTracker, readsIntersectDirty } from "./readTracker";

const { proxyStateMap } = unstable_getInternalStates();

const rawTargetOf = (value: object): object => proxyStateMap.get(value)?.[0] ?? value;

describe("dirtySinceSnapshot", () => {
	it("marks the changed path without emitting or writing occupancy", () => {
		const state = createMutableState({ count: 0, other: 0 });
		const handle = handleOf(state);

		if (handle === undefined) throw new Error("expected a handle");

		const from = snapshot(handle.proxy.root);
		const occupancy = copyOccupancyTables(handle);
		const lastSnapshot = handle.lastSnapshot;
		const lastDirty = handle.lastDirty;
		const heard = new Array<unknown>();

		subscribe(state, () => {
			heard.push(true);
		});

		state.count = 1;

		const dirty = dirtySinceSnapshot(handle, from);
		const rootRaw = rawTargetOf(state);
		const occupancyAfter = copyOccupancyTables(handle);

		expect(dirty.edges.get(rootRaw)?.has("count")).toBe(true);
		expect(dirty.edges.get(rootRaw)?.has("other")).toBe(false);
		expect(heard).toEqual([]);
		expect(handle.lastSnapshot).toBe(lastSnapshot);
		expect(handle.lastDirty).toBe(lastDirty);
		expect(occupancyAfter.ignoredAt.size).toBe(occupancy.ignoredAt.size);
		expect(occupancyAfter.unsafeAt.size).toBe(occupancy.unsafeAt.size);
		expect(occupancyAfter.routes.size).toBe(occupancy.routes.size);
	});

	it("intersects a tracker that read the changed field and misses an unread sibling", () => {
		const state = createMutableState({ count: 0, other: 0 });
		const handle = handleOf(state);

		if (handle === undefined) throw new Error("expected a handle");

		const from = snapshot(handle.proxy.root);
		const readTracker = createReadTracker();
		const readProxy = readTracker.wrap(state);

		void readProxy.count;
		state.count = 1;

		expect(readsIntersectDirty(readTracker, dirtySinceSnapshot(handle, from))).toBe(true);

		readTracker.resetReads();
		void readProxy.other;

		expect(readsIntersectDirty(readTracker, dirtySinceSnapshot(handle, from))).toBe(false);
	});

	it("marks a nested path on the live parent", () => {
		const state = createMutableState({ child: { n: 0 } });
		const handle = handleOf(state);

		if (handle === undefined) throw new Error("expected a handle");

		const from = snapshot(handle.proxy.root);

		state.child.n = 2;

		const dirty = dirtySinceSnapshot(handle, from);
		const childRaw = rawTargetOf(state.child);

		expect(dirty.edges.get(childRaw)?.has("n")).toBe(true);
		expect(dirty.nodes.has(rawTargetOf(state))).toBe(true);
		expect(dirty.nodes.has(childRaw)).toBe(true);
	});
});
