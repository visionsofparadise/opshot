import { transact } from "./transact/transact";
import { createProxy } from "proxy-compare";

import { createMutableState } from "./createMutableState";
import { getRegisteredTarget, resolveIdentity } from "./identity";
import { identify, isSameIdentity } from "./index";
import { createAssignMutation } from "./ops/operation";

describe("identity", () => {
	it("unifies raw, proxy, snapshot, and tracking-wrapper handles", () => {
		const raw = { value: 1 };
		const state = createMutableState({ item: raw });
		let mutableProxy: { value: number } | undefined;

		transact(state, () => {
			mutableProxy = state.item;
		});

		if (!mutableProxy) throw new Error("identity test: mutate did not expose the item proxy");

		const copy = state.item;
		const trackingWrapper = createProxy(copy, new WeakMap(), new WeakMap(), new WeakMap());
		const token = identify(raw);

		expect(Object.isFrozen(token)).toBe(true);
		expect(identify(mutableProxy)).toBe(token);
		expect(identify(copy)).toBe(token);
		expect(identify(trackingWrapper)).toBe(token);
		expect(isSameIdentity(raw, mutableProxy)).toBe(true);
		expect(isSameIdentity(raw, copy)).toBe(true);
		expect(isSameIdentity(raw, trackingWrapper)).toBe(true);
		expect(resolveIdentity(trackingWrapper)).toBe(raw);
	});

	it("mints stable frozen tokens for function identity leaves", () => {
		const first = (): string => "first";
		const second = (): string => "second";
		const token = identify(first);

		expect(Object.isFrozen(token)).toBe(true);
		expect(token).not.toBe(first);
		expect(identify(first)).toBe(token);
		expect(identify(second)).not.toBe(token);
		expect(isSameIdentity(first, first)).toBe(true);
		expect(isSameIdentity(first, second)).toBe(false);
		expect(resolveIdentity(first)).toBe(first);
	});

	it("keeps distinct states from one retained literal separate while sharing their nested target", () => {
		const retained = { nested: { value: 1 } };
		const first = createMutableState(retained);
		const second = createMutableState(retained);

		expect(isSameIdentity(first, second)).toBe(false);
		expect(identify(first)).not.toBe(identify(second));
		expect(isSameIdentity(first.nested, second.nested)).toBe(true);
		expect(identify(first.nested)).toBe(identify(second.nested));
	});

	it("leaves op-value clones unregistered as independent storage", () => {
		const original = { value: 1 };
		const operation = createAssignMutation(["item"], original);

		if (!("value" in operation)) throw new Error("identity test: value operation has no value");

		const clone = operation.value;

		if (typeof clone !== "object" || clone === null)
			throw new Error("identity test: operation did not return an object clone");

		expect(clone).not.toBe(original);
		expect(getRegisteredTarget(clone)).toBeUndefined();
		expect(resolveIdentity(clone)).toBe(clone);
		expect(isSameIdentity(clone, original)).toBe(false);
	});
});
