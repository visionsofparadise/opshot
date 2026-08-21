import { cloneValue } from "./cloneValue";
import { createOperationPath } from "./path";

describe("cloneValue", () => {
	it("copies a getter as an accessor without invoking it", () => {
		let invoked = 0;
		const getCurrent = (): number => {
			invoked += 1;

			return 1;
		};
		const value = Object.defineProperty({}, "current", {
			get: getCurrent,
			enumerable: true,
			configurable: true,
		});

		const cloned = cloneValue(value, new WeakMap(), createOperationPath([]));
		const descriptor = Reflect.getOwnPropertyDescriptor(cloned as object, "current");

		expect(invoked).toBe(0);
		expect(descriptor?.get).toBe(getCurrent);
		expect(descriptor && "value" in descriptor).toBe(false);
	});

	it("preserves frozenness on a cloned object", () => {
		const value = Object.freeze({ n: 1 });
		const cloned = cloneValue(value, new WeakMap(), createOperationPath([]));

		expect(Object.isFrozen(cloned)).toBe(true);
		expect(cloned).toEqual({ n: 1 });
		expect(cloned).not.toBe(value);
	});

	it("returns a frozen Map by identity", () => {
		const value = Object.freeze(new Map<string, number>([["k", 1]]));
		const cloned = cloneValue(value, new WeakMap(), createOperationPath([]));

		expect(cloned).toBe(value);
	});
});
