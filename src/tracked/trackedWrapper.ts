export const trackedBrand: unique symbol = Symbol.for("opshot.tracked");

export const brandTrackedPrototype = (prototype: object): void => {
	Object.defineProperty(prototype, trackedBrand, { value: true, enumerable: false, configurable: false, writable: false });
};

export const isTrackedWrapper = (value: unknown): value is object => typeof value === "object" && value !== null && Reflect.get(value, trackedBrand) === true;
