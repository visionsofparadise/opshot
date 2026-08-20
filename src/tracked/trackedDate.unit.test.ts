import { createProxy, isChanged } from "proxy-compare";
import { snapshot } from "valtio/vanilla";

import { subscribe } from "../subscribe";
import { transact } from "../transact/transact";
import { createMutableState } from "../createMutableState";
import { applyOperations } from "../ops/applyOperations";
import { type Operation } from "../ops/operation";
import { TrackedDate } from "./trackedDate";

const record = (state: object): Array<Array<Operation>> => {
	const heard = new Array<Array<Operation>>();

	subscribe(state, (ops) => {
		heard.push([...ops]);
	});

	return heard;
};

describe("TrackedDate", () => {
	it("records date reads through epochMs and changes the facade generation on mutation", () => {
		const state = createMutableState({ when: new TrackedDate(0) });
		const before = snapshot(state);
		const affected = new WeakMap();
		const renderState = createProxy(before, affected, new WeakMap(), new WeakMap());

		expect(renderState.when.getTime()).toBe(0);

		transact(state, () => {
			state.when.setTime(1);
		});

		const after = snapshot(state);

		expect(after.when).not.toBe(before.when);
		expect(after.when.getTime()).toBe(1);
		expect(isChanged(before, after, affected, new WeakMap())).toBe(true);
	});

	it("applies and inverts epochMs replacement through generic replay", () => {
		const state = createMutableState({ when: new TrackedDate(0) });
		const heard = record(state);

		transact(state, () => {
			state.when.setTime(1);
		});

		const pair = heard[0]?.[0];

		if (!pair) throw new Error("the epoch pair was not heard");

		applyOperations(state, [pair], "undo");
		expect(state.when.getTime()).toBe(0);

		applyOperations(state, [pair], "do");
		expect(state.when.getTime()).toBe(1);
	});
});
