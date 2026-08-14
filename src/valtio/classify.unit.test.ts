import { isTrackable } from "./classify";

describe("isTrackable", () => {
	it("rejects null and primitives", () => {
		expect(isTrackable(null)).toBe(false);
		expect(isTrackable(1)).toBe(false);
	});
});
