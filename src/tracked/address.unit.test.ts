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
	it("encodes every tag's output shape", () => {
		expect(addressOf("hello")).toBe("shello");
		expect(addressOf("")).toBe("s");
		expect(addressOf(5)).toBe("n5");
		expect(addressOf(0)).toBe("n0");
		expect(addressOf(NaN)).toBe("nNaN");
		expect(addressOf(1.5)).toBe("n1.5");
		expect(addressOf(10n)).toBe("i10");
		expect(addressOf(-3n)).toBe("i-3");
		expect(addressOf(true)).toBe("b1");
		expect(addressOf(false)).toBe("b0");
		expect(addressOf(undefined)).toBe("u");
		expect(addressOf(null)).toBe("z");
		expect(addressOf(Symbol.for("reg"))).toBe("rreg");
		expect(addressOf({})).toMatch(/^o\d+$/);
		expect(addressOf(() => undefined)).toMatch(/^o\d+$/);
		expect(addressOf(Symbol("local"))).toMatch(/^o\d+$/);
	});

	it("prevents cross-type collisions", () => {
		expect(addressOf("n5")).toBe("sn5");
		expect(addressOf(5)).toBe("n5");
		expect(addressOf("5")).toBe("s5");
		expect(addressOf("")).toBe("s");
		expect(addressOf(undefined)).toBe("u");
		expect(addressOf(null)).toBe("z");
		expect(addressOf("u")).toBe("su");
		expect(addressOf("z")).toBe("sz");
		expect(addressOf("b1")).toBe("sb1");
		expect(addressOf(true)).toBe("b1");
		expect(addressOf("NaN")).toBe("sNaN");
		expect(addressOf(NaN)).toBe("nNaN");
	});

	it("folds SameValueZero number edge cases", () => {
		expect(addressOf(-0)).toBe("n0");
		expect(addressOf(0)).toBe("n0");
		expect(addressOf(NaN)).toBe("nNaN");
		expect(addressOf(NaN)).toBe(addressOf(Number.NaN));
		expect(addressOf("NaN")).not.toBe(addressOf(NaN));
	});

	it("routes registered symbols by key and local symbols through the intern table", () => {
		const registered = Symbol.for("address-test-reg");
		const localA = Symbol("local-a");
		const localB = Symbol("local-b");

		expect(addressOf(registered)).toBe("raddress-test-reg");
		expect(addressOf(localA)).toMatch(/^o\d+$/);
		expect(addressOf(localA)).toBe(addressOf(localA));
		expect(addressOf(localB)).not.toBe(addressOf(localA));
	});

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
