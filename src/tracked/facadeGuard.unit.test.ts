import { createProxy } from "proxy-compare";
import { snapshot } from "valtio/vanilla";

import { createMutableState } from "../createMutableState";
import { TrackedDate } from "./trackedDate";
import { TrackedMap } from "./trackedMap";
import { TrackedSet } from "./trackedSet";

const createFacadeState = () =>
	createMutableState({
		map: new TrackedMap([["a", 1]]),
		set: new TrackedSet([1]),
		when: new TrackedDate(0),
	});

const expectSnapshotMutationRefused = (write: () => void): void => {
	expect(write).toThrow("opshot: cannot mutate a tracked collection snapshot");
};

describe("assertMutableFacade", () => {
	it("refuses mutation through a snapshot copy and leaves the live state unchanged", () => {
		const state = createFacadeState();
		const frozen = snapshot(state);

		expectSnapshotMutationRefused(() => {
			frozen.map.set("b", 2);
		});
		expectSnapshotMutationRefused(() => {
			frozen.set.add(2);
		});
		expectSnapshotMutationRefused(() => {
			frozen.when.setTime(1);
		});

		expect(state.map.size).toBe(1);
		expect(state.map.get("a")).toBe(1);
		expect(state.set.size).toBe(1);
		expect(state.set.has(1)).toBe(true);
		expect(state.when.getTime()).toBe(0);
		expect(frozen.map.size).toBe(1);
		expect(frozen.set.size).toBe(1);
		expect(frozen.when.getTime()).toBe(0);
	});

	it("refuses mutation through a proxy-compare render wrapper", () => {
		const state = createFacadeState();
		const frozen = snapshot(state);
		const wrapped = createProxy(frozen, new WeakMap(), new WeakMap(), new WeakMap());

		expectSnapshotMutationRefused(() => {
			wrapped.map.set("b", 2);
		});
		expectSnapshotMutationRefused(() => {
			wrapped.set.add(2);
		});
		expectSnapshotMutationRefused(() => {
			wrapped.when.setTime(1);
		});

		expect(state.map.size).toBe(1);
		expect(state.set.size).toBe(1);
		expect(state.when.getTime()).toBe(0);
	});
});
