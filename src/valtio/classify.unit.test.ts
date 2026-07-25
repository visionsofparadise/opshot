import { hasOwnEnumerableFunction, isTrackable } from "./classify";

describe("hasOwnEnumerableFunction", () => {
	it("detects own-enumerable function values and ignores prototype methods", () => {
		class WithMethod {
			x = 1;
			method() {
				return this.x;
			}
		}

		const clean = new WithMethod();
		const withOwnFn = Object.assign(new WithMethod(), { fn: () => 1 });

		expect(hasOwnEnumerableFunction(clean)).toBe(false);
		expect(hasOwnEnumerableFunction(withOwnFn)).toBe(true);
		expect(hasOwnEnumerableFunction({ callback: () => 0 })).toBe(true);
		expect(hasOwnEnumerableFunction({ x: 1 })).toBe(false);
	});
});

describe("isTrackable", () => {
	it("rejects null and primitives", () => {
		expect(isTrackable(null)).toBe(false);
		expect(isTrackable(1)).toBe(false);
	});
});
