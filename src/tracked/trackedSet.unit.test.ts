import { createState, type State } from "../createState";
import { identify, isSameIdentity } from "../identity";
import { applyOps } from "../ops/applyOps";
import type { Op, Operation } from "../ops/operation";
import { addressOf } from "./address";
import { TrackedSet } from "./trackedSet";

const record = <T extends object>(state: State<T>): Array<Array<Op>> => {
	const heard = new Array<Array<Op>>();

	state.op.subscribe((_snapshot, ops) => heard.push(ops));

	return heard;
};

const doPaths = (ops: Array<Op> | undefined): Array<Operation["path"]> => (ops ?? []).map((pair) => pair.do.path);

describe("TrackedSet", () => {
	it("implements ordered Set membership and deduplication", () => {
		const set = new TrackedSet([1, 2, 1]);

		expect(set.size).toBe(2);
		expect(set.has(1)).toBe(true);
		expect(set.add(3)).toBe(set);
		expect([...set]).toEqual([1, 2, 3]);
		expect([...set.entries()]).toEqual([
			[1, 1],
			[2, 2],
			[3, 3],
		]);
		expect(set.delete(2)).toBe(true);
		expect(set.delete(2)).toBe(false);
		set.clear();
		expect(set.size).toBe(0);
	});

	it("keeps tombstones so re-adds append and iteration skips deleted slots", () => {
		const set = new TrackedSet([1, 2]);

		set.delete(1);
		set.add(3);

		expect([...set]).toEqual([2, 3]);
		expect(set.size).toBe(2);
	});

	it("normalizes raw, proxy, and snapshot members by storage identity", () => {
		const member = { id: 1 };
		const state = createState({ set: new TrackedSet([member]) });
		const snapshotMember = [...state.set][0];

		if (!snapshotMember) throw new Error("missing snapshot member");

		state.mutate((mutable) => {
			const proxyMember = [...mutable.set][0];

			if (!proxyMember) throw new Error("missing proxy member");
			expect(mutable.set.has(member)).toBe(true);
			expect(mutable.set.has(snapshotMember)).toBe(true);
			expect(mutable.set.has(proxyMember)).toBe(true);
			mutable.set.add(snapshotMember);
		});

		expect(state.op.unwrap().set.size).toBe(1);
	});

	it("emits plain-data membership add and remove ops", () => {
		const pad = "x".repeat(5_000);
		const set = new TrackedSet<string>();

		for (let index = 0; index < 20; index++) set.add(`pad${index}${pad}`);

		const member = "member";
		const addr = addressOf(member);
		const state = createState({ set });
		const heard = record(state);

		state.mutate((mutable) => mutable.set.add(member));
		state.mutate((mutable) => mutable.set.delete(member));

		expect(doPaths(heard[0])).toEqual(
			expect.arrayContaining([
				["set", "index", addr],
				["set", "slots", 20],
				["set", "count"],
			]),
		);
		expect(heard[0]?.find((pair) => pair.do.path[1] === "slots" && pair.do.path[2] === 20)?.do.op).toBe("add");
		expect(heard[0]?.find((pair) => pair.do.path[1] === "index")?.do).toMatchObject({ op: "add", path: ["set", "index", addr], value: 20 });

		expect(doPaths(heard[1])).toEqual(
			expect.arrayContaining([
				["set", "index", addr],
				["set", "slots", 20],
				["set", "count"],
			]),
		);
		expect(heard[1]?.find((pair) => pair.do.path[1] === "slots")?.do).toMatchObject({ op: "replace", path: ["set", "slots", 20], value: null });
		expect(heard[1]?.find((pair) => pair.do.path[1] === "index")?.do.op).toBe("remove");
	});

	it("emits member interiors through slots", () => {
		const member = { profile: { count: 1 } };
		const state = createState({ set: new TrackedSet([member]) });
		const heard = record(state);

		state.mutate((mutable) => {
			const current = [...mutable.set][0];

			if (!current) throw new Error("missing member");
			current.profile.count = 2;
		});

		const operation = heard[0]?.[0]?.do;

		expect(operation?.op).toBe("replace");
		expect(operation?.path).toEqual(["set", "slots", 0, 0, "profile", "count"]);
	});

	it("round-trips clear and reorder through one collapsed container replace", () => {
		const state = createState({ set: new TrackedSet(["a", "b"]) });
		const heard = record(state);

		state.mutate((mutable) => {
			mutable.set.clear();
			mutable.set.add("b");
			mutable.set.add("a");
		});

		const ops = heard[0] ?? [];

		expect(ops).toHaveLength(1);
		expect(ops[0]?.do).toMatchObject({ op: "replace", path: ["set"] });
		applyOps(
			state,
			[...ops].reverse().map((pair) => pair.undo),
		);
		expect([...state.op.unwrap().set]).toEqual(["a", "b"]);
		applyOps(
			state,
			ops.map((pair) => pair.do),
		);
		expect([...state.op.unwrap().set]).toEqual(["b", "a"]);
	});

	it("preserves member identity through remove and restore", () => {
		const member = { id: 1 };
		const selection = new Map([[identify(member), "selected"]]);
		const state = createState({ set: new TrackedSet([member]) });
		const heard = record(state);

		state.mutate((mutable) => mutable.set.delete(member));
		const ops = heard[0] ?? [];
		applyOps(
			state,
			[...ops].reverse().map((pair) => pair.undo),
		);

		const restored = [...state.op.unwrap().set][0];

		expect(restored && selection.get(identify(restored))).toBe("selected");
		expect(restored && isSameIdentity(restored, member)).toBe(true);
	});

	it("retains full function after a minimal clean-class clone", () => {
		const set = new TrackedSet([1, 2]);
		const clone = Object.create(Object.getPrototypeOf(set)) as TrackedSet<number>;

		for (const key of Object.keys(set as object)) {
			Reflect.set(clone, key, Reflect.get(set as object, key));
		}

		expect(clone.size).toBe(2);
		expect(clone.has(1)).toBe(true);
		clone.add(3);
		expect([...clone]).toEqual([1, 2, 3]);
		expect(clone.delete(1)).toBe(true);
		expect([...clone]).toEqual([2, 3]);
		expect(Object.prototype.toString.call(clone)).toBe("[object TrackedSet]");
	});

	it("throws when mutating a snapshot copy", () => {
		const state = createState({ set: new TrackedSet([1]) });
		const snapshot = state.op.unwrap();

		expect(() => snapshot.set.add(2)).toThrow("opshot: cannot mutate a tracked collection snapshot");
		expect(snapshot.set.size).toBe(1);
	});
});
