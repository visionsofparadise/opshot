import { walkDataEntries } from "./dataEntries";

const symbolKey = Symbol("symbolKey");

const createFixture = (): object => {
	const fixture: Record<string, unknown> = { plain: 1 };

	Object.defineProperty(fixture, symbolKey, {
		value: "symbolValue",
		enumerable: true,
		writable: true,
		configurable: true,
	});
	Object.defineProperty(fixture, "hidden", {
		value: "hiddenValue",
		enumerable: false,
		writable: true,
		configurable: true,
	});
	Object.defineProperty(fixture, "locked", {
		value: "lockedValue",
		enumerable: true,
		writable: false,
		configurable: true,
	});
	Object.defineProperty(fixture, "__proto__", {
		value: "protoValue",
		enumerable: true,
		writable: true,
		configurable: true,
	});
	Object.defineProperty(fixture, "computed", {
		get: () => "computedValue",
		enumerable: true,
		configurable: true,
	});

	return fixture;
};

describe("walkDataEntries", () => {
	it("yields neither the symbol-keyed, the non-enumerable, the accessor, nor the __proto__ property", () => {
		const keys = walkDataEntries(createFixture()).map((entry) => entry.key);

		expect(keys).toEqual(["plain", "locked"]);
	});
});
