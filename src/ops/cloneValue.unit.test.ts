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
});
