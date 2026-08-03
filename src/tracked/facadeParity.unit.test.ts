import { createMutableState } from "../createMutableState";
import { applyOps } from "../ops/applyOps";
import { type Op } from "../ops/operation";
import { subscribe } from "../subscribe";
import { transact } from "../transact";
import { TrackedDate } from "./trackedDate";
import { TrackedMap } from "./trackedMap";
import { TrackedSet } from "./trackedSet";

type MapStep =
	| { readonly kind: "set"; readonly key: unknown; readonly value: unknown }
	| { readonly kind: "delete"; readonly key: unknown };

const MAP_SEQUENCE: ReadonlyArray<MapStep> = [
	{ kind: "set", key: "a", value: 1 },
	{ kind: "set", key: "b", value: 2 },
	{ kind: "set", key: "c", value: 3 },
	{ kind: "delete", key: "b" },
	{ kind: "set", key: "b", value: 9 },
	{ kind: "set", key: "a", value: 1 },
	{ kind: "set", key: -0, value: "zero" },
	{ kind: "set", key: NaN, value: "nan" },
	{ kind: "delete", key: "c" },
	{ kind: "set", key: "d", value: 4 },
];

const driveMap = (target: Map<unknown, unknown> | TrackedMap<unknown, unknown>): void => {
	for (const step of MAP_SEQUENCE) {
		if (step.kind === "set") target.set(step.key, step.value);
		else target.delete(step.key);
	}
};

const SET_SEQUENCE: ReadonlyArray<{ readonly kind: "add" | "delete"; readonly value: unknown }> = [
	{ kind: "add", value: "a" },
	{ kind: "add", value: "b" },
	{ kind: "add", value: "c" },
	{ kind: "delete", value: "b" },
	{ kind: "add", value: "b" },
	{ kind: "add", value: "a" },
	{ kind: "add", value: -0 },
	{ kind: "add", value: NaN },
	{ kind: "delete", value: "c" },
];

const driveSet = (target: Set<unknown> | TrackedSet<unknown>): void => {
	for (const step of SET_SEQUENCE) {
		if (step.kind === "add") target.add(step.value);
		else target.delete(step.value);
	}
};

describe("facade parity with the built-in", () => {
	it("matches Map on iteration order, keys, values, entries, and size", () => {
		const native = new Map<unknown, unknown>();
		const facade = new TrackedMap<unknown, unknown>();

		driveMap(native);
		driveMap(facade);

		expect(facade.size).toBe(native.size);
		expect([...facade.keys()]).toEqual([...native.keys()]);
		expect([...facade.values()]).toEqual([...native.values()]);
		expect([...facade.entries()]).toEqual([...native.entries()]);
		expect([...facade]).toEqual([...native]);
	});

	it("matches Map on -0 folding to 0 at storage", () => {
		const native = new Map<unknown, unknown>([[-0, "zero"]]);
		const facade = new TrackedMap<unknown, unknown>([[-0, "zero"]]);

		const nativeKey = [...native.keys()][0];
		const facadeKey = [...facade.keys()][0];

		expect(Object.is(nativeKey, 0)).toBe(true);
		expect(Object.is(facadeKey, 0)).toBe(true);
		expect(facade.get(0)).toBe(native.get(0));
		expect(facade.get(-0)).toBe(native.get(-0));
	});

	it("matches Map on delete-then-re-add moving the entry to the end", () => {
		const native = new Map<string, number>([
			["a", 1],
			["b", 2],
			["c", 3],
		]);
		const facade = new TrackedMap<string, number>([
			["a", 1],
			["b", 2],
			["c", 3],
		]);

		native.delete("a");
		facade.delete("a");
		native.set("a", 9);
		facade.set("a", 9);

		expect([...facade.keys()]).toEqual([...native.keys()]);
	});

	it("matches Set on iteration order, membership, and size", () => {
		const native = new Set<unknown>();
		const facade = new TrackedSet<unknown>();

		driveSet(native);
		driveSet(facade);

		expect(facade.size).toBe(native.size);
		expect([...facade.values()]).toEqual([...native.values()]);
		expect([...facade]).toEqual([...native]);
		expect(Object.is([...facade][3], [...native][3])).toBe(true);
	});

	it("matches Date on getTime, valueOf, and numeric coercion", () => {
		const epochMs = Date.UTC(2026, 7, 2, 12, 30, 15, 250);
		const native = new Date(epochMs);
		const facade = new TrackedDate(epochMs);

		expect(facade.getTime()).toBe(native.getTime());
		expect(facade.valueOf()).toBe(native.valueOf());
		expect(Number(facade)).toBe(Number(native));
		expect(facade.toISOString()).toBe(native.toISOString());
		expect(`${facade}`).toBe(`${native}`);
	});

	it("emits nothing when a re-set stores an Object.is-equal value", () => {
		const state = createMutableState({ map: new TrackedMap<string, number>([["a", 1]]) });
		const heard = new Array<Array<Op>>();

		subscribe(state, (ops) => heard.push([...ops]));

		transact(state, () => {
			state.map.set("a", 1);
		});

		expect(heard).toHaveLength(0);

		transact(state, () => {
			state.map.set("a", 2);
		});

		expect(heard).toHaveLength(1);
	});

	it("bounds slots by a constant factor of live size under churn", () => {
		const registry = new TrackedMap<string, number>();

		for (let index = 0; index < 10; index += 1) registry.set(`live${index}`, index);

		for (let cycle = 0; cycle < 5_000; cycle += 1) {
			registry.set(`transient${cycle}`, cycle);
			registry.delete(`transient${cycle}`);
		}

		expect(registry.size).toBe(10);
		expect([...registry.keys()]).toHaveLength(10);

		const slots = (registry as unknown as { slots: ReadonlyArray<unknown> }).slots;

		expect(slots.length).toBeLessThanOrEqual(2 * registry.size);
	});

	it("restores the exact prior layout when undo replays through a compaction", () => {
		const state = createMutableState({ map: new TrackedMap<string, number>() });
		const heard = new Array<Op>();

		for (const key of ["a", "b", "c", "d"]) {
			transact(state, () => {
				state.map.set(key, key.charCodeAt(0));
			});
		}

		transact(state, () => {
			state.map.delete("a");
		});

		const before = [...state.map.entries()];

		subscribe(state, (ops) => heard.push(...ops));

		transact(state, () => {
			state.map.delete("b");
		});

		expect([...state.map.keys()]).toEqual(["c", "d"]);

		const layoutOf = (map: TrackedMap<string, number>): ReadonlyArray<string | null> =>
			(map as unknown as { slots: ReadonlyArray<readonly [string, number] | null> }).slots.map((entry) =>
				entry === null ? null : entry[0],
			);

		expect(layoutOf(state.map)).toEqual(["c", "d"]);

		applyOps(state, heard.map((op) => op.undo).reverse());

		expect([...state.map.entries()]).toEqual(before);
		expect(layoutOf(state.map)).toEqual([null, "b", "c", "d"]);
	});
});
