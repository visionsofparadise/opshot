import { dataEntryValuesOf, segmentFor, walkDataEntries } from "./dataEntries";

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

	it("appends array length only when includeArrayLength is true", () => {
		const list = [10, 20];

		expect(walkDataEntries(list).map((entry) => entry.key)).toEqual(["0", "1"]);
		expect(walkDataEntries(list, true)).toEqual([
			{ key: "0", value: 10, writable: true },
			{ key: "1", value: 20, writable: true },
			{ key: "length", value: 2, writable: true },
		]);
	});
});

describe("segmentFor", () => {
	it("coerces canonical array indexes to numbers", () => {
		expect(segmentFor([10, 20], "0")).toBe(0);
		expect(segmentFor([10, 20], "1")).toBe(1);
	});

	it("keeps named keys on arrays as strings", () => {
		expect(segmentFor([10], "named")).toBe("named");
		expect(segmentFor([10], "length")).toBe("length");
	});

	it("keeps object keys as strings even when they look like indexes", () => {
		expect(segmentFor({ 0: 1 }, "0")).toBe("0");
	});
});

describe("dataEntryValuesOf", () => {
	it("includes array indexes and named keys", () => {
		const list = Object.assign([10, 20], { named: 3 });

		expect([...dataEntryValuesOf(list).keys()]).toEqual(["0", "1", "named"]);
		expect(dataEntryValuesOf(list).get("0")).toBe(10);
		expect(dataEntryValuesOf(list).get("named")).toBe(3);
	});
});
