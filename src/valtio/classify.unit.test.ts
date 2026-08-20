import { createMutableState } from "../createMutableState";
import { admissionLane } from "./classify";

describe("admissionLane", () => {
	it("classifies freeze as untracked", () => {
		expect(admissionLane(Object.freeze({ a: 1 }))).toBe("untracked");
	});

	it("classifies a primitive as a leaf and createMutableState returns it unchanged", () => {
		expect(admissionLane(1)).toBe("leaf");
		expect(createMutableState(1 as never)).toBe(1);
	});
});
