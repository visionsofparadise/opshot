import { createReadTracker } from "./react/readTracker";
import { createMutableState } from "./createMutableState";
import { isState } from "./isState";

describe("isState", () => {
	it("recognizes a live state", () => {
		expect(isState(createMutableState({ count: 0 }))).toBe(true);
		expect(isState({ count: 1 })).toBe(false);
	});

	it("recognizes a versioned readProxy over a live state", () => {
		const state = createMutableState({ count: 0 });
		const readProxy = createReadTracker().wrap(state);

		expect(isState(readProxy)).toBe(true);
		expect(readProxy).not.toBe(state);
	});
});
