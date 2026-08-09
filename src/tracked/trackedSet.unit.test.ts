import { snapshot } from "valtio/vanilla";

import { createMutableState } from "../createMutableState";
import { identify, isSameIdentity } from "../identity";
import { ignore } from "../ignore";
import { applyOperations } from "../ops/applyOperations";
import { type Operation, type Mutation } from "../ops/operation";
import { subscribe } from "../subscribe";
import { transact } from "../transact";
import { addressOf } from "./address";
import { TrackedSet } from "./trackedSet";

const record = <T extends object>(state: T): Array<Array<Operation>> => {
	const heard = new Array<Array<Operation>>();

	subscribe(state, (ops) => heard.push([...ops]));

	return heard;
};

const doPaths = (ops: Array<Operation> | undefined): Array<Mutation["path"]> => (ops ?? []).map((pair) => pair.do.path);

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
		const state = createMutableState({ set: new TrackedSet([member]) });
		const snapshotMember = [...state.set][0];

		if (!snapshotMember) throw new Error("missing snapshot member");

		transact(state, () => {
			const proxyMember = [...state.set][0];

			if (!proxyMember) throw new Error("missing proxy member");
			expect(state.set.has(member)).toBe(true);
			expect(state.set.has(snapshotMember)).toBe(true);
			expect(state.set.has(proxyMember)).toBe(true);
			state.set.add(snapshotMember);
		});

		expect(state.set.size).toBe(1);
	});

	it("emits plain-data membership add and remove ops", () => {
		const pad = "x".repeat(5_000);
		const set = new TrackedSet<string>();

		for (let index = 0; index < 20; index++) set.add(`pad${index}${pad}`);

		const member = "member";
		const addr = addressOf(member);
		const state = createMutableState({ set });
		const heard = record(state);

		transact(state, () => state.set.add(member));
		transact(state, () => state.set.delete(member));

		expect(doPaths(heard[0])).toEqual(
			expect.arrayContaining([
				["set", "index", addr],
				["set", "slots", 20],
				["set", "count"],
			]),
		);
		expect(heard[0]?.find((pair) => pair.do.path[1] === "slots" && pair.do.path[2] === 20)?.undo.verb).toBe("delete");
		expect(heard[0]?.find((pair) => pair.do.path[1] === "index")?.do).toMatchObject({
			verb: "assign",
			path: ["set", "index", addr],
			value: 20,
		});
		expect(heard[0]?.find((pair) => pair.do.path[1] === "index")?.undo.verb).toBe("delete");

		expect(doPaths(heard[1])).toEqual(
			expect.arrayContaining([
				["set", "index", addr],
				["set", "slots", 20],
				["set", "count"],
			]),
		);
		expect(heard[1]?.find((pair) => pair.do.path[1] === "slots")?.do).toMatchObject({
			verb: "assign",
			path: ["set", "slots", 20],
			value: null,
		});
		expect(heard[1]?.find((pair) => pair.do.path[1] === "index")?.do.verb).toBe("delete");
	});

	it("emits member interiors through slots", () => {
		const member = { profile: { count: 1 } };
		const state = createMutableState({ set: new TrackedSet([member]) });
		const heard = record(state);

		transact(state, () => {
			const current = [...state.set][0];

			if (!current) throw new Error("missing member");
			current.profile.count = 2;
		});

		const operation = heard[0]?.[0]?.do;

		expect(operation?.verb).toBe("assign");
		expect(operation?.path).toEqual(["set", "slots", 0, 0, "profile", "count"]);
	});

	it("round-trips clear and reorder through one collapsed container replace", () => {
		const state = createMutableState({ set: new TrackedSet(["a", "b"]) });
		const heard = record(state);

		transact(state, () => {
			state.set.clear();
			state.set.add("b");
			state.set.add("a");
		});

		const ops = heard[0] ?? [];

		expect(ops).toHaveLength(1);
		expect(ops[0]?.do).toMatchObject({ verb: "assign", path: ["set"] });
		applyOperations(state, ops, "undo");
		expect([...state.set]).toEqual(["a", "b"]);
		applyOperations(state, ops, "do");
		expect([...state.set]).toEqual(["b", "a"]);
	});

	it("preserves member identity through remove and restore", () => {
		const member = { id: 1 };
		const selection = new Map([[identify(member), "selected"]]);
		const state = createMutableState({ set: new TrackedSet([member]) });
		const heard = record(state);

		transact(state, () => state.set.delete(member));
		const ops = heard[0] ?? [];
		applyOperations(state, ops, "undo");

		const restored = [...state.set][0];

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
		const state = createMutableState({ set: new TrackedSet([1]) });
		const frozen = snapshot(state);

		expect(() => frozen.set.add(2)).toThrow("opshot: cannot mutate a tracked collection snapshot");
		expect(frozen.set.size).toBe(1);
	});

	it("keeps an ignored member by reference and silent on its interior writes", () => {
		class Point {
			x = 1;
		}

		const member = ignore(new Point());
		const state = createMutableState({ set: new TrackedSet([member]) });
		const heard = record(state);
		const held = [...state.set][0];

		expect(held).toBe(member);

		transact(state, () => {
			const current = [...state.set][0];

			if (typeof current !== "object" || current === null) throw new Error("missing member");

			(current as { x: number }).x = 2;
		});

		expect(heard).toHaveLength(0);
		expect([...state.set][0]).toBe(member);
		expect(member.x).toBe(2);
	});
});
