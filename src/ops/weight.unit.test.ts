import { ignore } from "../ignore";
import { TrackedDate } from "../tracked/trackedDate";
import { TrackedMap } from "../tracked/trackedMap";
import { CHARACTER_WEIGHT, KEY_WEIGHT, LEAF_WEIGHT, NODE_WEIGHT, weighValue } from "./weight";

describe("weighValue", () => {
	it("aborts once accumulated weight exceeds the budget", () => {
		const wide: Record<string, number> = {};

		for (let index = 0; index < 32; index++) wide[`k${index}`] = index;

		const weight = weighValue(wide, NODE_WEIGHT);

		expect(weight).toBeGreaterThan(NODE_WEIGHT);
		expect(weight).toBe(NODE_WEIGHT + KEY_WEIGHT);
	});

	it("weights strings by leaf plus character length", () => {
		expect(weighValue("abcd", Number.MAX_SAFE_INTEGER)).toBe(LEAF_WEIGHT + CHARACTER_WEIGHT * 4);
		expect(weighValue("", Number.MAX_SAFE_INTEGER)).toBe(LEAF_WEIGHT);
	});

	it("charges zero for identity leaves: functions, ignore()d values, and frozen objects", () => {
		const ignored = ignore({ nested: { text: "x".repeat(1_000) }, more: { a: 1, b: 2, c: 3 } });
		const largeFunction = Object.assign(() => undefined, {
			cache: { values: Array.from({ length: 100 }, (_, index) => index) },
		});
		const frozen = Object.freeze({ nested: { text: "x".repeat(1_000) }, more: { a: 1, b: 2, c: 3 } });

		expect(weighValue(ignored, Number.MAX_SAFE_INTEGER)).toBe(0);
		expect(weighValue(largeFunction, Number.MAX_SAFE_INTEGER)).toBe(0);
		expect(weighValue(frozen, Number.MAX_SAFE_INTEGER)).toBe(0);
		expect(weighValue({ held: ignored }, Number.MAX_SAFE_INTEGER)).toBe(NODE_WEIGHT + KEY_WEIGHT);
	});

	it("counts a shared DAG subtree once", () => {
		const shared = { n: 1 };
		const root = { a: shared, b: shared };
		const sharedWeight = NODE_WEIGHT + KEY_WEIGHT + LEAF_WEIGHT;
		const expected = NODE_WEIGHT + KEY_WEIGHT + sharedWeight + KEY_WEIGHT;

		expect(weighValue(root, Number.MAX_SAFE_INTEGER)).toBe(expected);
		expect(weighValue(shared, Number.MAX_SAFE_INTEGER)).toBe(sharedWeight);
	});

	it("weighs TrackedMap as a clean-class container including tombstones", () => {
		const withTombstone = new TrackedMap<number, number>([
			[1, 10],
			[2, 20],
			[3, 30],
			[4, 40],
		]);

		withTombstone.delete(1);

		const liveOnly = new TrackedMap<number, number>([
			[2, 20],
			[3, 30],
			[4, 40],
		]);
		const budget = Number.MAX_SAFE_INTEGER;

		expect(weighValue(withTombstone, budget)).toBeGreaterThan(weighValue(liveOnly, budget));
		expect(weighValue(liveOnly, budget)).toBeGreaterThan(NODE_WEIGHT);
	});

	it("weighs TrackedDate as a clean-class container over epochMs", () => {
		const date = new TrackedDate(0);
		const expected = NODE_WEIGHT + KEY_WEIGHT + LEAF_WEIGHT;

		expect(weighValue(date, Number.MAX_SAFE_INTEGER)).toBe(expected);
		expect(weighValue(new TrackedDate(Date.UTC(2026, 0, 1)), Number.MAX_SAFE_INTEGER)).toBe(expected);
	});

	it("charges nothing for a hole and a leaf for stored undefined", () => {
		const withHole = new Array<unknown>(1);
		const withUndefined = [undefined];

		expect(weighValue(withHole, Number.MAX_SAFE_INTEGER)).toBe(NODE_WEIGHT);
		expect(weighValue(withUndefined, Number.MAX_SAFE_INTEGER)).toBe(NODE_WEIGHT + KEY_WEIGHT + LEAF_WEIGHT);
	});
});
