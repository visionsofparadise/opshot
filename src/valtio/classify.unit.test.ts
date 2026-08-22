import { createMutableState } from "../createMutableState";
import { admissionLane, unfrozenAdmissionLane } from "./classify";

describe("admissionLane", () => {
	it("classifies freeze as untracked", () => {
		expect(admissionLane(Object.freeze({ a: 1 }))).toBe("untracked");
	});

	it("classifies a primitive as a leaf and createMutableState returns it unchanged", () => {
		expect(admissionLane(1)).toBe("leaf");
		expect(createMutableState(1 as never)).toBe(1);
	});
});

describe("unfrozenAdmissionLane", () => {
	it("classifies a frozen Map as dangerous", () => {
		const frozenMap = Object.freeze(new Map());

		expect(admissionLane(frozenMap)).toBe("untracked");
		expect(unfrozenAdmissionLane(frozenMap)).toBe("dangerous");
	});

	it("classifies a frozen plain object as tracked", () => {
		expect(unfrozenAdmissionLane(Object.freeze({ a: 1 }))).toBe("tracked");
	});
});
