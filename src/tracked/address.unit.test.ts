import { transact } from "../transact/transact";
import { snapshot } from "valtio/vanilla";

import { createMutableState } from "../createMutableState";
import { resolveIdentity } from "../identity";
import { applyOperations } from "../ops/applyOperations";
import { diffObjects } from "../ops/diff";
import { type Operation } from "../ops/operation";
import { addressOf } from "./address";

const undo = <T extends object>(state: T, ops: Array<Operation>): void => {
	applyOperations(state, ops, "undo");
};

describe("addressOf", () => {
	it("interns the same object once across raw, proxy, snapshot, and undo handles", () => {
		const state = createMutableState<{ item: { label: string }; sibling: number }>({
			item: { label: "a" },
			sibling: 0,
		});
		const proxied = state as { item: { label: string }; sibling: number };

		const addressProxy = addressOf(proxied.item);
		const snapA = snapshot(proxied) as { item: { label: string }; sibling: number };
		const addressSnapA = addressOf(snapA.item);

		transact(state, () => {
			state.sibling = 1;
		});

		const snapB = snapshot(proxied) as { item: { label: string }; sibling: number };
		const addressSnapB = addressOf(snapB.item);

		const ops = diffObjects(snapA, snapB);

		undo(state, ops);

		const addressAfterUndo = addressOf((snapshot(proxied) as { item: { label: string } }).item);

		expect(addressSnapA).toBe(addressProxy);
		expect(addressSnapB).toBe(addressProxy);
		expect(addressAfterUndo).toBe(addressProxy);
		expect(resolveIdentity(snapA.item)).toBe(resolveIdentity(proxied.item));
	});

	it("gives distinct equal-content objects distinct addresses", () => {
		const first = { label: "same" };
		const second = { label: "same" };

		expect(addressOf(first)).not.toBe(addressOf(second));
		expect(addressOf(first)).toBe(addressOf(first));
	});
});
