import { discardPendingOccupancy, recordPendingOccupancy, takePendingOccupancy } from "./occupancy";

describe("pending occupancy", () => {
	it("takePendingOccupancy spends a parent+key record when the live child does not match", () => {
		const parent = {};
		const first = { n: 1 };
		const second = { n: 2 };

		recordPendingOccupancy(parent, "foo", first, "unsafe");

		expect(takePendingOccupancy(parent, "foo", second)).toBeUndefined();
		expect(takePendingOccupancy(parent, "foo", first)).toBeUndefined();
	});

	it("takePendingOccupancy returns the kind when the live child matches", () => {
		const parent = {};
		const child = { n: 1 };

		recordPendingOccupancy(parent, "foo", child, "ignore");

		expect(takePendingOccupancy(parent, "foo", child)).toBe("ignore");
		expect(takePendingOccupancy(parent, "foo", child)).toBeUndefined();
	});

	it("discardPendingOccupancy drops a parent+key record", () => {
		const parent = {};
		const child = { n: 1 };

		recordPendingOccupancy(parent, "foo", child, "unsafe");
		discardPendingOccupancy(parent, "foo");

		expect(takePendingOccupancy(parent, "foo", child)).toBeUndefined();
	});
});
