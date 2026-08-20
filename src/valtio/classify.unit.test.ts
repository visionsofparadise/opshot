import { admissionLane } from "./classify";

describe("admissionLane", () => {
	it("classifies freeze as untracked", () => {
		expect(admissionLane(Object.freeze({ a: 1 }))).toBe("untracked");
	});
});
