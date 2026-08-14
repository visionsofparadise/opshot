import { ignore } from "../ignore";
import { admissionLane } from "./classify";

describe("admissionLane", () => {
	it("classifies non-objects as leaves", () => {
		expect(admissionLane(null)).toBe("leaf");
		expect(admissionLane(1)).toBe("leaf");
		expect(admissionLane(() => 1)).toBe("leaf");
	});

	it("classifies ignore() and freeze as untracked", () => {
		expect(admissionLane(ignore({ a: 1 }))).toBe("untracked");
		expect(admissionLane(Object.freeze({ a: 1 }))).toBe("untracked");
	});
});
