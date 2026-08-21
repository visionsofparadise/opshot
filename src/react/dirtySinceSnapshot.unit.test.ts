import { snapshot, unstable_getInternalStates } from "valtio/vanilla";

import { createMutableState } from "../createMutableState";
import { handleOf } from "../handle";
import { subscribe } from "../subscribe";
import { dirtySinceSnapshot } from "./dirtySinceSnapshot";

const { proxyStateMap } = unstable_getInternalStates();

const rawTargetOf = (value: object): object => proxyStateMap.get(value)?.[0] ?? value;

describe("dirtySinceSnapshot", () => {
	it("marks the changed edge on the live parent and leaves an unread sibling unmarked without emitting or touching the handle's tables", () => {
		const state = createMutableState({ count: 0, other: 0 });
		const handle = handleOf(state);

		if (handle === undefined) throw new Error("expected a handle");

		const from = snapshot(handle.proxy.root);
		const lastSnapshot = handle.lastSnapshot;
		const lastDirty = handle.lastDirty;
		const declarations = handle.declarations;
		const inEdges = handle.inEdges;
		const interned = handle.interned;
		const internedById = handle.internedById;
		const internCount = handle.internedById.size;
		const nextInternId = handle.nextInternId;
		const heard = new Array<unknown>();

		subscribe(state, () => {
			heard.push(true);
		});

		state.count = 1;

		const dirty = dirtySinceSnapshot(handle, from);
		const rootRaw = rawTargetOf(state);

		expect(dirty.edges.get(rootRaw)?.has("count")).toBe(true);
		expect(dirty.edges.get(rootRaw)?.has("other")).toBe(false);
		expect(heard).toEqual([]);
		expect(handle.lastSnapshot).toBe(lastSnapshot);
		expect(handle.lastDirty).toBe(lastDirty);
		expect(handle.declarations).toBe(declarations);
		expect(handle.inEdges).toBe(inEdges);
		expect(handle.interned).toBe(interned);
		expect(handle.internedById).toBe(internedById);
		expect(handle.internedById.size).toBe(internCount);
		expect(handle.nextInternId).toBe(nextInternId);
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
