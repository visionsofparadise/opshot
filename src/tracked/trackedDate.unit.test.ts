import { createProxy, isChanged } from "proxy-compare";
import { snapshot } from "valtio/vanilla";

import { subscribe } from "../subscribe";
import { batch } from "../batch";
import { createMutableState } from "../createMutableState";
import { applyOperations } from "../ops/applyOperations";
import { createAssignMutation, type Operation } from "../ops/operation";
import { shapeOps } from "../ops/operationShape";
import { TrackedDate } from "./trackedDate";

const record = (state: object): Array<Array<Operation>> => {
	const heard = new Array<Array<Operation>>();

	subscribe(state, (ops) => {
		heard.push([...ops]);
	});

	return heard;
};

describe("TrackedDate", () => {
	it("records date reads through epochMs and changes the facade generation on mutation", () => {
		const state = createMutableState({ when: new TrackedDate(0) });
		const before = snapshot(state);
		const affected = new WeakMap();
		const renderState = createProxy(before, affected, new WeakMap(), new WeakMap());

		expect(renderState.when.getTime()).toBe(0);

		batch(() => {
			state.when.setTime(1);
		});

		const after = snapshot(state);

		expect(after.when).not.toBe(before.when);
		expect(after.when.getTime()).toBe(1);
		expect(isChanged(before, after, affected, new WeakMap())).toBe(true);
	});

	it("applies and inverts epochMs replacement through generic replay", () => {
		const state = createMutableState({ when: new TrackedDate(0) });
		const heard = record(state);

		batch(() => {
			state.when.setTime(1);
		});

		const pair = heard[0]?.[0];

		if (!pair) throw new Error("the epoch pair was not heard");

		applyOperations(state, [pair], "undo");
		expect(state.when.getTime()).toBe(0);

		applyOperations(state, [pair], "do");
		expect(state.when.getTime()).toBe(1);
	});

	it("a mutation emits a scalar epochMs assign pair of plain numbers", () => {
		const state = createMutableState({ when: new TrackedDate(0) });
		const heard = record(state);

		batch(() => {
			state.when.setTime(1);
		});

		const shaped = shapeOps(heard[0] ?? []);

		expect(shaped).toEqual([
			{
				do: { verb: "assign", path: ["when", "epochMs"], value: 1 },
				undo: { verb: "assign", path: ["when", "epochMs"], value: 0 },
			},
		]);
		expect(JSON.parse(JSON.stringify(shaped))).toEqual(shaped);
	});

	it("out-of-range and non-finite epochs clip to NaN, including one arriving by replay", () => {
		const date = new TrackedDate(0);

		expect(date.setTime(Number.POSITIVE_INFINITY)).toBeNaN();
		expect(date.getTime()).toBeNaN();

		const negative = new TrackedDate(0);

		expect(negative.setTime(Number.NEGATIVE_INFINITY)).toBeNaN();
		expect(negative.getTime()).toBeNaN();

		const nonFinite = new TrackedDate(0);

		expect(nonFinite.setTime(Number.NaN)).toBeNaN();
		expect(nonFinite.getTime()).toBeNaN();

		const overflow = new TrackedDate(0);

		expect(overflow.setTime(8.64e15 + 1)).toBeNaN();
		expect(overflow.getTime()).toBeNaN();

		const state = createMutableState({ when: new TrackedDate(0) });

		applyOperations(
			state,
			[
				{
					do: createAssignMutation(["when", "epochMs"], 8.64e15 + 1),
					undo: createAssignMutation(["when", "epochMs"], 0),
				},
			],
			"do",
		);

		expect((state.when as unknown as { epochMs: number }).epochMs).toBe(8.64e15 + 1);
		expect(state.when.getTime()).toBeNaN();
	});

	it("Symbol.toPrimitive coerces to epochMs under a number hint and the date string otherwise", () => {
		const epochMs = Date.UTC(2020, 0, 2, 3, 4, 5, 6);
		const tracked = new TrackedDate(epochMs);
		const native = new Date(epochMs);

		expect(tracked[Symbol.toPrimitive]("number")).toBe(epochMs);
		expect(tracked[Symbol.toPrimitive]("string")).toBe(native[Symbol.toPrimitive]("string"));
		expect(tracked[Symbol.toPrimitive]("default")).toBe(native[Symbol.toPrimitive]("default"));
	});

	it("setYear applies legacy two-digit years and getYear offsets by 1900, lockstep with Date", () => {
		const epochMs = Date.UTC(2020, 0, 1);
		const tracked = new TrackedDate(epochMs);
		const native = new Date(epochMs);
		const nativeGetYear: unknown = Reflect.get(native, "getYear");
		const nativeSetYear: unknown = Reflect.get(native, "setYear");

		if (typeof nativeGetYear !== "function" || typeof nativeSetYear !== "function") {
			throw new Error("Date year methods are not callable");
		}

		expect(tracked.getYear()).toBe(Reflect.apply(nativeGetYear, native, []));
		expect(tracked.getYear()).toBe(2020 - 1900);

		expect(tracked.setYear(25)).toBe(Reflect.apply(nativeSetYear, native, [25]));
		expect(tracked.getTime()).toBe(native.getTime());
		expect(tracked.getFullYear()).toBe(1925);
		expect(tracked.getYear()).toBe(25);
		expect(tracked.getYear()).toBe(Reflect.apply(nativeGetYear, native, []));
		expect(tracked.getFullYear()).toBe(native.getFullYear());
	});

	it("supports the no-argument and full seven-component constructor forms", () => {
		const before = Date.now();
		const constructed = new TrackedDate();
		const after = Date.now();

		expect(constructed.getTime()).toBeGreaterThanOrEqual(before);
		expect(constructed.getTime()).toBeLessThanOrEqual(after);

		expect(new TrackedDate(2020, 4, 6, 7, 8, 9, 10).getTime()).toBe(new Date(2020, 4, 6, 7, 8, 9, 10).getTime());
	});
});
