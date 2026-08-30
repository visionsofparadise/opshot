import { batch } from "../batch";
import { snapshot } from "valtio/vanilla";

import { createMutableState } from "../createMutableState";
import { internIdentity, resolveIdentity } from "../identity";
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

		batch(() => {
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

	it("gives each key type a distinct prefix so cross-type keys never collide", () => {
		const addresses = [
			addressOf(5),
			addressOf("5"),
			addressOf("n5"),
			addressOf(true),
			addressOf("b1"),
			addressOf(null),
			addressOf("z"),
			addressOf(undefined),
			addressOf("u"),
			addressOf(NaN),
			addressOf("NaN"),
		];

		expect(addresses).toEqual(["n5", "s5", "sn5", "b1", "sb1", "z", "sz", "u", "su", "nNaN", "sNaN"]);
		expect(new Set(addresses).size).toBe(addresses.length);
	});

	it("SameValueZero folds -0 with 0 and repeated NaN to one address", () => {
		expect(addressOf(-0)).toBe(addressOf(0));
		expect(addressOf(-0)).toBe("n0");
		expect(addressOf(NaN)).toBe(addressOf(Number.NaN));
		expect(addressOf(NaN)).toBe("nNaN");
	});

	it("addresses a registered symbol by its key and a local symbol through the intern table", () => {
		const registered = Symbol.for("opshot-address-registered");
		const local = Symbol("opshot-address-local");
		const other = Symbol("opshot-address-other");

		expect(addressOf(registered)).toBe("ropshot-address-registered");
		expect(addressOf(local)).toBe(`o${internIdentity(local)}`);
		expect(addressOf(local)).toBe(addressOf(local));
		expect(addressOf(other)).not.toBe(addressOf(local));
	});
});
