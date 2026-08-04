import { createProxy } from "proxy-compare";
import { createMutableState } from "../createMutableState";
import { resolveWriteProxy } from "./resolveWriteProxy";

describe("resolveWriteProxy", () => {
	it("returns the live proxy for a bare state", () => {
		const state = createMutableState({ count: 0 });

		expect(resolveWriteProxy(state)).toBe(state);
	});

	it("peels a tracking wrapper to the live proxy", () => {
		const state = createMutableState({ count: 0 });
		const wrapper = createProxy(state, new WeakMap(), new WeakMap(), new WeakMap());

		expect(resolveWriteProxy(wrapper)).toBe(state);
	});

	it("throws when the value is not a state", () => {
		expect(() => resolveWriteProxy({ count: 0 })).toThrow("opshot: expected a state object");
	});
});
