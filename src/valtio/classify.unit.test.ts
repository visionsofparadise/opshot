import { ignore } from "../ignore";
import { admissionLane } from "./classify";

describe("admissionLane", () => {
	it("classifies non-objects as leaves", () => {
		expect(admissionLane(null)).toBe("leaf");
		expect(admissionLane(1)).toBe("leaf");
		expect(admissionLane(() => 1)).toBe("leaf");
	});

	it("classifies freeze as untracked and does not treat ignore() as untracked", () => {
		expect(admissionLane(ignore({ a: 1 }))).toBe("tracked");
		expect(admissionLane(Object.freeze({ a: 1 }))).toBe("untracked");
	});
});
