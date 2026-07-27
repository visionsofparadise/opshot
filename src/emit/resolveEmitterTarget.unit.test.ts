import { createProxy } from "proxy-compare";
import { createMutableState } from "../createMutableState";
import { resolveEmitterTarget } from "./resolveEmitterTarget";

describe("resolveEmitterTarget", () => {
	it("returns the live proxy for a bare state", () => {
		const state = createMutableState({ count: 0 });

		expect(resolveEmitterTarget(state)).toBe(state);
	});

	it("peels a tracking wrapper to the live proxy", () => {
		const state = createMutableState({ count: 0 });
		const wrapper = createProxy(state, new WeakMap(), new WeakMap(), new WeakMap());

		expect(resolveEmitterTarget(wrapper)).toBe(state);
	});

	it("throws when the value is not a state", () => {
		expect(() => resolveEmitterTarget({ count: 0 })).toThrow("opshot: expected a state object");
	});
});
