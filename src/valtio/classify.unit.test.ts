import { ignore } from "../ignore";
import { TrackedMap } from "../tracked/trackedMap";
import { unsafeTrack } from "../unsafeTrack";
import { classifyValue, hasOwnEnumerableFunction, isTrackable } from "./classify";

describe("classifyValue", () => {
	it("keeps the existing kind distinctions", () => {
		expect(classifyValue({})).toBe("plain");
		expect(classifyValue([])).toBe("plainArray");

		class Clean {
			x = 1;
		}

		class Private {
			#x = 1;
			reveal() {
				return this.#x;
			}
		}

		class Stack extends Array<number> {}

		expect(classifyValue(new Clean())).toBe("cleanClass");
		expect(classifyValue(new Private())).toBe("privateClass");
		expect(classifyValue(new Stack())).toBe("arraySubclass");
		expect(classifyValue(new Map())).toBe("nativeClass");
	});
});

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
	it("admits plain data and clean classes; excludes facades, ignored, frozen, and dirty clean classes", () => {
		class Clean {
			x = 1;
		}

		class Arrowed {
			x = 1;
			fn = () => this.x;
		}

		class Private {
			#x = 1;
			public y = 0;
			reveal() {
				return this.#x;
			}
		}

		expect(isTrackable({ a: 1 })).toBe(true);
		expect(isTrackable([1])).toBe(true);
		expect(isTrackable(new Clean())).toBe(true);
		expect(isTrackable(new Arrowed())).toBe(false);
		expect(isTrackable(new Private())).toBe(false);
		expect(isTrackable(new TrackedMap())).toBe(false);
		expect(isTrackable(ignore({ a: 1 }))).toBe(false);
		expect(isTrackable(Object.freeze({ a: 1 }))).toBe(false);
		expect(isTrackable(unsafeTrack(new Arrowed()))).toBe(true);
		expect(isTrackable(unsafeTrack(new Private()))).toBe(true);
		expect(isTrackable(null)).toBe(false);
		expect(isTrackable(1)).toBe(false);
	});
});
