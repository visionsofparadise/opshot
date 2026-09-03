import { createMutableState } from "../createMutableState";
import { isSameIdentity } from "../identity";
import type { Operation } from "../operation";
import { subscribe } from "../subscribe";
import { TrackedMap } from "./trackedMap";

const listen = (state: object): Array<ReadonlyArray<Operation>> => {
	const heard: Array<ReadonlyArray<Operation>> = [];

	subscribe(state, (operations) => {
		heard.push(operations);
	});

	return heard;
};

describe("TrackedMap", () => {
	it("matches Map for size, has, get, set, delete, clear, and iteration", () => {
		const tracked = new TrackedMap<string, number>([
			["a", 1],
			["b", 2],
		]);
		const native = new Map<string, number>([
			["a", 1],
			["b", 2],
		]);

		expect(tracked.size).toBe(native.size);
		expect(tracked.has("a")).toBe(native.has("a"));
		expect(tracked.get("a")).toBe(native.get("a"));
		expect(tracked.get("missing")).toBe(native.get("missing"));
		expect([...tracked]).toEqual([...native]);
		expect([...tracked.keys()]).toEqual([...native.keys()]);
		expect([...tracked.values()]).toEqual([...native.values()]);
		expect([...tracked.entries()]).toEqual([...native.entries()]);

		const trackedSeen: Array<[string, number]> = [];
		const nativeSeen: Array<[string, number]> = [];

		tracked.forEach((value, key) => trackedSeen.push([key, value]));
		native.forEach((value, key) => nativeSeen.push([key, value]));

		expect(trackedSeen).toEqual(nativeSeen);

		expect(tracked.set("c", 3)).toBe(tracked);
		expect(native.set("c", 3)).toBe(native);
		expect(tracked.size).toBe(native.size);
		expect(tracked.delete("b")).toBe(true);
		expect(native.delete("b")).toBe(true);
		expect(tracked.delete("b")).toBe(false);
		expect([...tracked]).toEqual([...native]);

		tracked.clear();
		native.clear();

		expect(tracked.size).toBe(0);
		expect(native.size).toBe(0);
		expect([...tracked]).toEqual([]);
	});

	it("folds -0 with 0 the way Map does", () => {
		const tracked = new TrackedMap<number, string>([[0, "zero"]]);
		const native = new Map<number, string>([[0, "zero"]]);

		expect(tracked.get(-0)).toBe(native.get(-0));
		expect(tracked.has(-0)).toBe(true);
	});
});

describe("§5.1 every change to a tracked node reaches that state's subscribers", () => {
	it("a mutation through the facade emits operations on the facade's own data entries", async () => {
		const state = createMutableState({ map: new TrackedMap<string, number>() });
		const heard = listen(state);

		state.map.set("a", 1);

		await Promise.resolve();

		const keys = heard[0]?.map((operation) => operation.key) ?? [];

		expect(keys).toEqual(expect.arrayContaining(["0", "length", "sa", "count"]));
		expect(heard[0]?.some((operation) => operation.node === state.map && operation.key === "count")).toBe(true);
		expect(state.map.get("a")).toBe(1);
	});
});

describe("§1.4 an edge is dangerous and untracked when it is an exotic hidden store", () => {
	it("a TrackedMap is admitted in a strict state", () => {
		const state = createMutableState({ map: new TrackedMap([["a", 1]]) });

		expect(state.map.get("a")).toBe(1);
		expect(() => createMutableState({ map: new Map() })).toThrow("cannot be tracked");
	});
});

describe("§2.2 assigning a node into a state it currently occupies keeps its identity in that state", () => {
	it("identity-keyed lookups survive proxying", () => {
		const key = { id: 1 };
		const value = { label: "held" };
		const state = createMutableState({
			map: new TrackedMap<object, { label: string }>([[key, value]]),
			key,
			value,
		});

		expect(state.map.get(key)).toBe(state.value);
		expect(state.map.get(state.key)).toBe(state.value);
		expect(state.map.has(state.key)).toBe(true);
		expect(isSameIdentity(state.map.get(state.key) ?? {}, value)).toBe(true);
	});
});
