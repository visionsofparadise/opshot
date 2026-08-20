import { createProxy } from "proxy-compare";

import { createMutableState } from "./createMutableState";
import { identify, isSameIdentity } from "./index";
import { transact } from "./transact/transact";

describe("identity", () => {
	it("keeps a tracked node's identity across raw, proxy, snapshot, and tracking-wrapper reads", () => {
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

		expect(identify(mutableProxy)).toBe(token);
		expect(identify(copy)).toBe(token);
		expect(identify(trackingWrapper)).toBe(token);
		expect(isSameIdentity(raw, mutableProxy)).toBe(true);
		expect(isSameIdentity(raw, copy)).toBe(true);
		expect(isSameIdentity(raw, trackingWrapper)).toBe(true);
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
});
