import { createMutableState } from "../createMutableState";
import type { Operation } from "../operation";
import { subscribe } from "../subscribe";
import { TrackedDate } from "./trackedDate";

const listen = (state: object): Array<ReadonlyArray<Operation>> => {
	const heard: Array<ReadonlyArray<Operation>> = [];

	subscribe(state, (operations) => {
		heard.push(operations);
	});

	return heard;
};

describe("TrackedDate", () => {
	it("matches Date for the epoch constructors and the UTC field accessors", () => {
		const epochMs = Date.UTC(2020, 0, 2, 3, 4, 5, 6);
		const tracked = new TrackedDate(epochMs);
		const native = new Date(epochMs);

		expect(tracked.getTime()).toBe(native.getTime());
		expect(tracked.valueOf()).toBe(native.valueOf());
		expect(tracked.toISOString()).toBe(native.toISOString());
		expect(tracked.toUTCString()).toBe(native.toUTCString());
		expect(tracked.getUTCFullYear()).toBe(native.getUTCFullYear());
		expect(tracked.getUTCMonth()).toBe(native.getUTCMonth());
		expect(tracked.getUTCDate()).toBe(native.getUTCDate());
		expect(tracked.getUTCHours()).toBe(native.getUTCHours());
		expect(tracked.getUTCMinutes()).toBe(native.getUTCMinutes());
		expect(tracked.getUTCSeconds()).toBe(native.getUTCSeconds());
		expect(tracked.getUTCMilliseconds()).toBe(native.getUTCMilliseconds());
		expect(tracked.getUTCDay()).toBe(native.getUTCDay());

		expect(tracked.setTime(1)).toBe(native.setTime(1));
		expect(tracked.getTime()).toBe(native.getTime());
	});

	it("matches Date for the seven-component constructor", () => {
		const tracked = new TrackedDate(2020, 0, 2, 3, 4, 5, 6);
		const native = new Date(2020, 0, 2, 3, 4, 5, 6);

		expect(tracked.getTime()).toBe(native.getTime());
	});

	it("Symbol.toPrimitive matches Date under each hint", () => {
		const epochMs = Date.UTC(2020, 0, 2, 3, 4, 5, 6);
		const tracked = new TrackedDate(epochMs);
		const native = new Date(epochMs);

		expect(tracked[Symbol.toPrimitive]("number")).toBe(native[Symbol.toPrimitive]("number"));
		expect(tracked[Symbol.toPrimitive]("string")).toBe(native[Symbol.toPrimitive]("string"));
		expect(tracked[Symbol.toPrimitive]("default")).toBe(native[Symbol.toPrimitive]("default"));
	});

	it("clips out-of-range and non-finite epochs to NaN the way Date does", () => {
		const tracked = new TrackedDate(0);
		const native = new Date(0);

		expect(tracked.setTime(Number.POSITIVE_INFINITY)).toBeNaN();
		expect(native.setTime(Number.POSITIVE_INFINITY)).toBeNaN();
		expect(tracked.getTime()).toBeNaN();
		expect(new TrackedDate(0).setTime(8.64e15 + 1)).toBeNaN();
	});

	it("setYear and getYear stay in lockstep with Date", () => {
		const epochMs = Date.UTC(2020, 0, 1);
		const tracked = new TrackedDate(epochMs);
		const native = new Date(epochMs);
		const nativeGetYear: unknown = Reflect.get(native, "getYear");
		const nativeSetYear: unknown = Reflect.get(native, "setYear");

		if (typeof nativeGetYear !== "function" || typeof nativeSetYear !== "function") {
			throw new Error("Date year methods are not callable");
		}

		expect(tracked.getYear()).toBe(Reflect.apply(nativeGetYear, native, []));
		expect(tracked.setYear(25)).toBe(Reflect.apply(nativeSetYear, native, [25]));
		expect(tracked.getTime()).toBe(native.getTime());
		expect(tracked.getFullYear()).toBe(native.getFullYear());
	});
});

describe("§5.1 every change to a tracked node reaches that state's subscribers", () => {
	it("a mutation through the facade emits operations on the facade's own data entries", async () => {
		const state = createMutableState({ when: new TrackedDate(0) });
		const heard = listen(state);

		state.when.setTime(1);

		await Promise.resolve();

		expect(heard[0]).toHaveLength(1);
		expect(heard[0]?.[0]?.node).toBe(state.when);
		expect(heard[0]?.[0]).toMatchObject({ key: "epochMs", before: 0, after: 1 });
	});
});

describe("§1.4 an edge is dangerous and untracked when it is an exotic hidden store", () => {
	it("a TrackedDate is admitted in a strict state", () => {
		const state = createMutableState({ when: new TrackedDate(0) });

		expect(state.when.getTime()).toBe(0);
		expect(() => createMutableState({ when: new Date(0) })).toThrow("cannot be tracked");
	});
});

describe("§2.2 assigning a node into a state it currently occupies keeps its identity in that state", () => {
	it("the date the state returns is the same node after a later occupancy", () => {
		const when = new TrackedDate(0);
		const state = createMutableState({ when, copy: when });

		expect(state.when).toBe(state.copy);

		state.copy = state.when;

		expect(state.when).toBe(state.copy);
		expect(state.when.getTime()).toBe(0);
	});
});
