import { createMutableState } from "../createMutableState";
import { applyOperations } from "../ops/applyOperations";
import { type Operation } from "../ops/operation";
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
		const heard = new Array<Array<Operation>>();

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
		const heard = new Array<Operation>();

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

		applyOperations(state, heard.map((op) => op.undo).reverse());

		expect([...state.map.entries()]).toEqual(before);
		expect(layoutOf(state.map)).toEqual([null, "b", "c", "d"]);
	});

	type MutationStep =
		| { readonly kind: "next" }
		| { readonly kind: "set"; readonly key: string; readonly value: number }
		| { readonly kind: "delete"; readonly key: string }
		| { readonly kind: "clear" };

	const slotsOf = (map: TrackedMap<string, number>): ReadonlyArray<unknown> =>
		(map as unknown as { slots: ReadonlyArray<unknown> }).slots;

	const runLockstep = (
		initial: ReadonlyArray<readonly [string, number]>,
		steps: ReadonlyArray<MutationStep>,
	): void => {
		const native = new Map(initial);
		const facade = new TrackedMap(initial);
		const nativeIterator = native.keys();
		const facadeIterator = facade.keys();

		for (const step of steps) {
			if (step.kind === "next") {
				const nativeResult = nativeIterator.next();
				const facadeResult = facadeIterator.next();

				expect(facadeResult.done).toBe(nativeResult.done);
				if (!nativeResult.done) expect(facadeResult.value).toBe(nativeResult.value);
				continue;
			}

			if (step.kind === "set") {
				native.set(step.key, step.value);
				facade.set(step.key, step.value);
			} else if (step.kind === "delete") {
				native.delete(step.key);
				facade.delete(step.key);
			} else {
				native.clear();
				facade.clear();
			}
		}

		for (;;) {
			const nativeResult = nativeIterator.next();
			const facadeResult = facadeIterator.next();

			expect(facadeResult.done).toBe(nativeResult.done);
			if (nativeResult.done) break;
			expect(facadeResult.value).toBe(nativeResult.value);
		}
	};

	const MUTATION_SEQUENCES: ReadonlyArray<{
		readonly name: string;
		readonly initial: ReadonlyArray<readonly [string, number]>;
		readonly steps: ReadonlyArray<MutationStep>;
	}> = [
		{
			name: "clear mid-iteration with no adds after",
			initial: [
				["a", 1],
				["b", 2],
				["c", 3],
			],
			steps: [{ kind: "next" }, { kind: "clear" }],
		},
		{
			name: "clear mid-iteration followed by adds",
			initial: [
				["a", 1],
				["b", 2],
				["c", 3],
			],
			steps: [
				{ kind: "next" },
				{ kind: "clear" },
				{ kind: "set", key: "d", value: 4 },
				{ kind: "set", key: "e", value: 5 },
			],
		},
		{
			name: "delete an entry ahead of the cursor",
			initial: [
				["a", 1],
				["b", 2],
			],
			steps: [{ kind: "next" }, { kind: "delete", key: "b" }],
		},
		{
			name: "add during iteration",
			initial: [
				["a", 1],
				["b", 2],
			],
			steps: [{ kind: "next" }, { kind: "set", key: "c", value: 3 }],
		},
		{
			name: "delete each entry as it is yielded",
			initial: [
				["a", 1],
				["b", 2],
				["c", 3],
				["d", 4],
				["e", 5],
				["f", 6],
			],
			steps: [
				{ kind: "next" },
				{ kind: "delete", key: "a" },
				{ kind: "next" },
				{ kind: "delete", key: "b" },
				{ kind: "next" },
				{ kind: "delete", key: "c" },
				{ kind: "next" },
				{ kind: "delete", key: "d" },
				{ kind: "next" },
				{ kind: "delete", key: "e" },
				{ kind: "next" },
				{ kind: "delete", key: "f" },
			],
		},
		{
			name: "delete-then-re-add during iteration",
			initial: [
				["a", 1],
				["b", 2],
				["c", 3],
			],
			steps: [{ kind: "next" }, { kind: "delete", key: "b" }, { kind: "set", key: "b", value: 9 }],
		},
	];

	it.each(MUTATION_SEQUENCES)("matches Map on mutation-during-iteration: $name", ({ initial, steps }) => {
		runLockstep(initial, steps);
	});

	const TEN_ENTRIES: ReadonlyArray<readonly [string, number]> = Array.from({ length: 10 }, (_, index) => [
		`k${index}`,
		index,
	]);

	const driveComposition = (
		map: TrackedMap<string, number>,
		mutate: (body: () => void) => void = (body) => body(),
	): Array<string> => {
		const iterator = map.keys();
		const yielded = new Array<string>();

		for (let step = 0; step < 4; step += 1) {
			const result = iterator.next();

			expect(result.done).toBe(false);
			yielded.push(result.value as string);
		}

		const slotsAfterAdvance = slotsOf(map);

		mutate(() => {
			for (const key of ["k5", "k6", "k7", "k8", "k9"]) map.delete(key);
		});

		const slotsAfterFirst = slotsOf(map);

		expect(slotsAfterFirst).not.toBe(slotsAfterAdvance);
		expect(slotsAfterFirst.length).toBeLessThan(slotsAfterAdvance.length);

		mutate(() => {
			for (const key of ["k0", "k1", "k2"]) map.delete(key);
		});

		const slotsAfterSecond = slotsOf(map);

		expect(slotsAfterSecond).not.toBe(slotsAfterFirst);
		expect(slotsAfterSecond.length).toBeLessThan(slotsAfterFirst.length);

		for (;;) {
			const result = iterator.next();

			if (result.done) break;
			yielded.push(result.value as string);
		}

		return yielded;
	};

	const driveCompositionNative = (): Array<string> => {
		const map = new Map(TEN_ENTRIES);
		const iterator = map.keys();
		const yielded = new Array<string>();

		for (let step = 0; step < 4; step += 1) {
			const result = iterator.next();

			expect(result.done).toBe(false);
			yielded.push(result.value as string);
		}

		for (const key of ["k5", "k6", "k7", "k8", "k9"]) map.delete(key);
		for (const key of ["k0", "k1", "k2"]) map.delete(key);

		for (;;) {
			const result = iterator.next();

			if (result.done) break;
			yielded.push(result.value as string);
		}

		return yielded;
	};

	it("matches Map on the multi-rebuild composition schedule", () => {
		const expected = driveCompositionNative();
		const bare = new TrackedMap(TEN_ENTRIES);
		const bareYielded = driveComposition(bare);

		expect(bareYielded).toEqual(expected);
		expect(bareYielded).toContain("k4");

		const state = createMutableState({ map: new TrackedMap(TEN_ENTRIES) });
		const inStateYielded = driveComposition(state.map, (body) => {
			transact(state, body);
		});

		expect(inStateYielded).toEqual(expected);
		expect(inStateYielded).toContain("k4");
	});

	it("matches Map when two iterators straddle one rebuild", () => {
		const native = new Map(TEN_ENTRIES);
		const facade = new TrackedMap(TEN_ENTRIES);
		const nativeEarly = native.keys();
		const nativeLate = native.keys();
		const facadeEarly = facade.keys();
		const facadeLate = facade.keys();

		for (let step = 0; step < 2; step += 1) {
			expect(facadeEarly.next().value).toBe(nativeEarly.next().value);
		}

		for (let step = 0; step < 7; step += 1) {
			expect(facadeLate.next().value).toBe(nativeLate.next().value);
		}

		const slotsBefore = slotsOf(facade);

		for (const key of ["k1", "k3", "k5", "k7", "k9"]) {
			native.delete(key);
			facade.delete(key);
		}

		expect(slotsOf(facade)).not.toBe(slotsBefore);

		const drain = (iterator: Iterator<string>): Array<string> => {
			const rest = new Array<string>();

			for (;;) {
				const result = iterator.next();

				if (result.done) break;
				rest.push(result.value);
			}

			return rest;
		};

		expect(drain(facadeEarly)).toEqual(drain(nativeEarly));
		expect(drain(facadeLate)).toEqual(drain(nativeLate));
	});

	const churnInterior = (map: TrackedMap<string, number>, cycles: number): void => {
		for (let cycle = 0; cycle < cycles; cycle += 1) {
			map.set(`transient${cycle}`, cycle);
			if (cycle > 0) map.delete(`transient${cycle - 1}`);
		}

		if (cycles > 0) map.delete(`transient${cycles - 1}`);
	};

	const seedLive = (): TrackedMap<string, number> => {
		const map = new TrackedMap<string, number>();

		for (let index = 0; index < 10; index += 1) map.set(`live${index}`, index);

		return map;
	};

	const assertCompacted = (map: TrackedMap<string, number>): void => {
		expect(map.size).toBe(10);
		expect([...map.keys()]).toEqual(Array.from({ length: 10 }, (_, index) => `live${index}`));
		expect(slotsOf(map).length).toBeLessThanOrEqual(2 * map.size);
	};

	it("keeps compaction working after an iterator advanced once and dropped", () => {
		const map = seedLive();

		map.keys().next();
		churnInterior(map, 5_000);
		assertCompacted(map);
	});

	it("keeps compaction working after an iterator advanced partway and dropped", () => {
		const map = seedLive();
		const iterator = map.keys();

		for (let step = 0; step < 4; step += 1) iterator.next();

		churnInterior(map, 5_000);
		assertCompacted(map);
	});

	it("keeps compaction working after an exhausted iterator with no return, then more churn", () => {
		const map = seedLive();
		const iterator = map.keys();

		for (;;) {
			if (iterator.next().done) break;
		}

		churnInterior(map, 5_000);
		assertCompacted(map);
	});
});
