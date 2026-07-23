import { createProxy, isChanged } from "proxy-compare";
import { snapshot } from "valtio/vanilla";

import { subscribe } from "../subscribe";
import { transact } from "../transact";
import { createMutableState } from "../createMutableState";
import { applyOps } from "../ops/applyOps";
import { type Op, type Operation } from "../ops/operation";
import { TrackedDate } from "./trackedDate";

const readValue = (half: Operation | undefined): unknown => (half !== undefined && "value" in half ? half.value : undefined);

const recordAll = (state: object): Array<{ ops: Array<Op>; meta: unknown }> => {
	const heard = new Array<{ ops: Array<Op>; meta: unknown }>();

	subscribe(state, (ops, meta) => {
		heard.push({ ops: [...ops], meta });
	});

	return heard;
};

const readMethodNames = [
	"toString",
	"toDateString",
	"toTimeString",
	"toLocaleString",
	"toLocaleDateString",
	"toLocaleTimeString",
	"valueOf",
	"getTime",
	"getFullYear",
	"getYear",
	"getUTCFullYear",
	"getMonth",
	"getUTCMonth",
	"getDate",
	"getUTCDate",
	"getDay",
	"getUTCDay",
	"getHours",
	"getUTCHours",
	"getMinutes",
	"getUTCMinutes",
	"getSeconds",
	"getUTCSeconds",
	"getMilliseconds",
	"getUTCMilliseconds",
	"getTimezoneOffset",
	"toUTCString",
	"toGMTString",
	"toISOString",
] as const;

const setterCases: ReadonlyArray<readonly [string, ReadonlyArray<number>]> = [
	["setTime", [1_234_567]],
	["setYear", [25]],
	["setMilliseconds", [123]],
	["setUTCMilliseconds", [234]],
	["setSeconds", [12, 345]],
	["setUTCSeconds", [13, 456]],
	["setMinutes", [14, 15, 567]],
	["setUTCMinutes", [16, 17, 678]],
	["setHours", [8, 18, 19, 789]],
	["setUTCHours", [9, 20, 21, 890]],
	["setDate", [22]],
	["setUTCDate", [23]],
	["setMonth", [5, 24]],
	["setUTCMonth", [6, 25]],
	["setFullYear", [2025, 7, 26]],
	["setUTCFullYear", [2026, 8, 27]],
];

describe("TrackedDate facade", () => {
	it("implements every Date read method from epochMs without native Date slots or toJSON", () => {
		const epochMs = Date.UTC(2020, 4, 6, 7, 8, 9, 123);
		const date = new TrackedDate(epochMs);
		const native = new Date(epochMs);

		for (const name of readMethodNames) {
			const facadeMethod: unknown = Reflect.get(date, name);
			const nativeMethod: unknown = Reflect.get(native, name);

			if (typeof facadeMethod !== "function" || typeof nativeMethod !== "function") throw new Error(`${name} is not callable`);

			expect(Reflect.apply(facadeMethod, date, [])).toEqual(Reflect.apply(nativeMethod, native, []));
		}

		const missingMethods = Reflect.ownKeys(Date.prototype).filter((key) => key !== "constructor" && key !== "toJSON" && !Reflect.has(TrackedDate.prototype, key));

		expect(missingMethods).toEqual([]);
		expect(date).not.toBeInstanceOf(Date);
		expect(date).toBeInstanceOf(TrackedDate);
		expect(Object.prototype.toString.call(date)).toBe("[object TrackedDate]");
		expect(date[Symbol.toStringTag]).toBe("TrackedDate");
		expect(date[Symbol.toPrimitive]("number")).toBe(native[Symbol.toPrimitive]("number"));
		expect(date[Symbol.toPrimitive]("string")).toBe(native[Symbol.toPrimitive]("string"));
		expect("toJSON" in date).toBe(false);
		expect(Object.keys(date)).toEqual(["epochMs"]);
		expect(JSON.stringify(date)).toBe(`{"epochMs":${epochMs}}`);
		expect(() => Date.prototype.getTime.call(date)).toThrow(TypeError);
	});

	it("supports the Date constructor forms", () => {
		expect(new TrackedDate(0).getTime()).toBe(0);
		expect(new TrackedDate("2020-01-01T00:00:00.000Z").getTime()).toBe(Date.UTC(2020, 0, 1));
		expect(new TrackedDate(2020, 4, 6, 7, 8, 9, 10).getTime()).toBe(new Date(2020, 4, 6, 7, 8, 9, 10).getTime());
	});

	it.each(setterCases)("writes epochMs through %s", (name, args) => {
		const epochMs = Date.UTC(2020, 0, 2, 3, 4, 5, 6);
		const date = new TrackedDate(epochMs);
		const native = new Date(epochMs);
		const facadeMethod: unknown = Reflect.get(date, name);
		const nativeMethod: unknown = Reflect.get(native, name);

		if (typeof facadeMethod !== "function" || typeof nativeMethod !== "function") throw new Error(`${name} is not callable`);

		const expected = Reflect.apply(nativeMethod, native, args);
		const result = Reflect.apply(facadeMethod, date, args);

		expect(result).toBe(expected);
		expect(date.getTime()).toBe(expected);
		expect(date.getTime()).toBe(native.getTime());
	});

	it("preserves omitted setter arguments", () => {
		const epochMs = Date.UTC(2020, 0, 2, 3, 4, 5, 678);
		const date = new TrackedDate(epochMs);
		const native = new Date(epochMs);

		expect(date.setUTCSeconds(30)).toBe(native.setUTCSeconds(30));
		expect(date.getTime()).toBe(native.getTime());
	});

	it("matches setYear on invalid dates and coerces its argument", () => {
		const cases: ReadonlyArray<readonly [number, unknown]> = [
			[Number.NaN, 25],
			[0, "25"],
		];

		for (const [epochMs, year] of cases) {
			const date = new TrackedDate(epochMs);
			const native = new Date(epochMs);
			const setYear: unknown = Reflect.get(date, "setYear");
			const nativeSetYear: unknown = Reflect.get(native, "setYear");

			if (typeof setYear !== "function" || typeof nativeSetYear !== "function") throw new Error("setYear is not callable");

			expect(Reflect.apply(setYear, date, [year])).toBe(Reflect.apply(nativeSetYear, native, [year]));
			expect(date.getTime()).toBe(native.getTime());
		}
	});

	it("throws when setYear receives a BigInt, matching Date", () => {
		const date = new TrackedDate(0);
		const native = new Date(0);
		const setYear: unknown = Reflect.get(date, "setYear");
		const nativeSetYear: unknown = Reflect.get(native, "setYear");

		if (typeof setYear !== "function" || typeof nativeSetYear !== "function") throw new Error("setYear is not callable");

		expect(() => Reflect.apply(setYear, date, [1n])).toThrow(TypeError);
		expect(() => Reflect.apply(nativeSetYear, native, [1n])).toThrow(TypeError);
		expect(date.getTime()).toBe(0);
	});

	it("records date reads through epochMs and changes the facade generation on mutation", () => {
		const state = createMutableState({ when: new TrackedDate(0) });
		const before = snapshot(state);
		const affected = new WeakMap();
		const renderState = createProxy(before, affected, new WeakMap(), new WeakMap());

		expect(renderState.when.getTime()).toBe(0);

		transact(state, () => {
			state.when.setTime(1);
		});

		const after = snapshot(state);

		expect(after.when).not.toBe(before.when);
		expect(after.when.getTime()).toBe(1);
		expect(isChanged(before, after, affected, new WeakMap())).toBe(true);
	});

	it("rejects snapshot and tracking-wrapper setters before changing epochMs", () => {
		const state = createMutableState({ when: new TrackedDate(0) });
		const frozen = snapshot(state);
		const renderState = createProxy(frozen, new WeakMap(), new WeakMap(), new WeakMap());

		for (const date of [frozen.when, renderState.when]) {
			expect(() => date.setTime(1)).toThrow("opshot: cannot mutate a tracked collection snapshot");
			expect(() => date.setYear(25)).toThrow("opshot: cannot mutate a tracked collection snapshot");
		}

		expect(frozen.when.getTime()).toBe(0);
		expect(state.when.getTime()).toBe(0);
	});

	it("retains full function after a minimal clean-class clone", () => {
		const date = new TrackedDate(1_000);
		const clone = Object.create(Object.getPrototypeOf(date)) as TrackedDate;

		for (const key of Object.keys(date as object)) {
			Reflect.set(clone, key, Reflect.get(date as object, key));
		}

		expect(clone.getTime()).toBe(1_000);
		expect(clone.setTime(2_000)).toBe(2_000);
		expect(clone.getTime()).toBe(2_000);
		expect(Object.prototype.toString.call(clone)).toBe("[object TrackedDate]");
	});
});

describe("TrackedDate atomic emission", () => {
	it("emits a scalar epochMs replacement pair", () => {
		const state = createMutableState({ when: new TrackedDate(Date.UTC(2020, 0, 1)) });
		const heard = recordAll(state);

		transact(state, () => {
			state.when.setUTCFullYear(2024);
		});

		const pair = heard[0]?.ops[0];

		if (!pair) throw new Error("the epoch pair was not heard");

		expect(heard[0]?.ops).toHaveLength(1);
		expect(heard[0]?.meta).toBeUndefined();
		expect(pair.do.op).toBe("replace");
		expect(pair.do.path).toEqual(["when", "epochMs"]);
		expect(readValue(pair.do)).toBe(Date.UTC(2024, 0, 1));
		expect(pair.undo.op).toBe("replace");
		expect(pair.undo.path).toEqual(["when", "epochMs"]);
		expect(readValue(pair.undo)).toBe(Date.UTC(2020, 0, 1));
	});

	it("applies and inverts epochMs replacement through generic replay", () => {
		const state = createMutableState({ when: new TrackedDate(0) });
		const heard = recordAll(state);

		transact(state, () => {
			state.when.setTime(1);
		});

		const pair = heard[0]?.ops[0];

		if (!pair) throw new Error("the epoch pair was not heard");

		applyOps(state, [pair.undo]);
		expect(state.when.getTime()).toBe(0);

		applyOps(state, [pair.do]);
		expect(state.when.getTime()).toBe(1);
	});
});
