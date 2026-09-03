import { createMutableState } from "../createMutableState";
import { isSameIdentity } from "../identity";
import type { Operation } from "../operation";
import { subscribe } from "../subscribe";
import { TrackedSet } from "./trackedSet";

const listen = (state: object): Array<ReadonlyArray<Operation>> => {
	const heard: Array<ReadonlyArray<Operation>> = [];

	subscribe(state, (operations) => {
		heard.push(operations);
	});

	return heard;
};

describe("TrackedSet", () => {
	it("matches Set for size, has, add, delete, clear, and iteration", () => {
		const tracked = new TrackedSet<string>(["a", "b"]);
		const native = new Set<string>(["a", "b"]);

		expect(tracked.size).toBe(native.size);
		expect(tracked.has("a")).toBe(native.has("a"));
		expect(tracked.has("missing")).toBe(native.has("missing"));
		expect([...tracked]).toEqual([...native]);
		expect([...tracked.keys()]).toEqual([...native.keys()]);
		expect([...tracked.values()]).toEqual([...native.values()]);
		expect([...tracked.entries()]).toEqual([...native.entries()]);

		const trackedSeen: Array<string> = [];
		const nativeSeen: Array<string> = [];

		tracked.forEach((value) => trackedSeen.push(value));
		native.forEach((value) => nativeSeen.push(value));

		expect(trackedSeen).toEqual(nativeSeen);

		expect(tracked.add("c")).toBe(tracked);
		expect(native.add("c")).toBe(native);
		expect(tracked.size).toBe(native.size);
		expect(tracked.delete("b")).toBe(true);
		expect(native.delete("b")).toBe(true);
		expect(tracked.delete("b")).toBe(false);
		expect([...tracked]).toEqual([...native]);

		tracked.clear();
		native.clear();

		expect(tracked.size).toBe(0);
		expect([...tracked]).toEqual([]);
	});

	it("folds -0 with 0 the way Set does", () => {
		const tracked = new TrackedSet<number>([0]);
		const native = new Set<number>([0]);

		expect(tracked.has(-0)).toBe(native.has(-0));
	});
});

describe("§5.1 every change to a tracked node reaches that state's subscribers", () => {
	it("a mutation through the facade emits operations on the facade's own data entries", async () => {
		const state = createMutableState({ set: new TrackedSet<string>() });
		const heard = listen(state);

		state.set.add("a");

		await Promise.resolve();

		const keys = heard[0]?.map((operation) => operation.key) ?? [];

		expect(keys).toEqual(expect.arrayContaining(["0", "length", "sa", "count"]));
		expect(heard[0]?.some((operation) => operation.node === state.set && operation.key === "count")).toBe(true);
		expect(state.set.has("a")).toBe(true);
	});
});

describe("§1.4 an edge is dangerous and untracked when it is an exotic hidden store", () => {
	it("a TrackedSet is admitted in a strict state", () => {
		const state = createMutableState({ set: new TrackedSet(["a"]) });

		expect(state.set.has("a")).toBe(true);
		expect(() => createMutableState({ set: new Set() })).toThrow("cannot be tracked");
	});
});

describe("§2.2 assigning a node into a state it currently occupies keeps its identity in that state", () => {
	it("identity-keyed lookups survive proxying", () => {
		const member = { id: 1 };
		const state = createMutableState({
			set: new TrackedSet([member]),
			member,
		});

		expect(state.set.has(member)).toBe(true);
		expect(state.set.has(state.member)).toBe(true);
		expect(isSameIdentity([...state.set][0] ?? {}, member)).toBe(true);
	});
});
