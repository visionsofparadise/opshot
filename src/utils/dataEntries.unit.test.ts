import { carriedOwnKeysOf, walkDataEntries } from "./dataEntries";

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
	it("yields neither the symbol-keyed, the non-enumerable, nor the __proto__ property", () => {
		const keys = walkDataEntries(createFixture()).map((entry) => entry.key);

		expect(keys).toEqual(["plain", "locked"]);
	});

	it("yields the non-writable entry with writable false", () => {
		const entries = walkDataEntries(createFixture());

		expect(entries).toContainEqual({ key: "locked", value: "lockedValue", writable: false });
		expect(entries).toContainEqual({ key: "plain", value: 1, writable: true });
	});

	it("keeps all four fixture properties out of the writable-filtered set", () => {
		const writableKeys = walkDataEntries(createFixture())
			.filter((entry) => entry.writable)
			.map((entry) => entry.key);

		expect(writableKeys).toEqual(["plain"]);
	});

	it("yields no entry for an accessor property", () => {
		const keys = walkDataEntries(createFixture()).map((entry) => entry.key);

		expect(keys).not.toContain("computed");
	});

	it("appends array length only when includeArrayLength is true", () => {
		const list = [10, 20];

		expect(walkDataEntries(list).map((entry) => entry.key)).toEqual(["0", "1"]);
		expect(walkDataEntries(list, true)).toEqual([
			{ key: "0", value: 10, writable: true },
			{ key: "1", value: 20, writable: true },
			{ key: "length", value: 2, writable: true },
		]);
		expect(walkDataEntries({ length: 3 }, true).map((entry) => entry.key)).toEqual(["length"]);
		expect(walkDataEntries({ length: 3 }, true)[0]).toEqual({ key: "length", value: 3, writable: true });
	});
});

describe("carriedOwnKeysOf", () => {
	it("yields every own key except __proto__", () => {
		expect(carriedOwnKeysOf(createFixture())).toEqual(["plain", "hidden", "locked", "computed", symbolKey]);
	});
});
