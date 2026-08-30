import { cloneValue } from "./cloneValue";
import { createOperationPath } from "./path";

describe("cloneValue", () => {
	it("omits an enumerable accessor without invoking it", () => {
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

		expect(invoked).toBe(0);
		expect(Reflect.getOwnPropertyDescriptor(cloned as object, "current")).toBeUndefined();
		expect(Reflect.ownKeys(cloned as object)).toEqual([]);
	});

	it("returns a frozen object by identity", () => {
		const value = Object.freeze({ n: 1 });
		const cloned = cloneValue(value, new WeakMap(), createOperationPath([]));

		expect(cloned).toBe(value);
		expect(Object.isFrozen(cloned)).toBe(true);
	});

	it("returns a frozen Map by identity", () => {
		const value = Object.freeze(new Map<string, number>([["k", 1]]));
		const cloned = cloneValue(value, new WeakMap(), createOperationPath([]));

		expect(cloned).toBe(value);
	});
});
