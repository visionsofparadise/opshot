import { createState, type State } from "../createState";
import { identify, isSameIdentity } from "../identity";
import { applyOps } from "../ops/applyOps";
import type { Op } from "../ops/operation";
import { TrackedSet } from "./trackedSet";

const record = <T extends object>(state: State<T>): Array<Array<Op>> => {
	const heard = new Array<Array<Op>>();

	state.op.subscribe((_snapshot, ops) => heard.push(ops));

	return heard;
};

describe("TrackedSet", () => {
	it("implements ordered Set membership and deduplication", () => {
		const set = new TrackedSet([1, 2, 1]);

		expect(set.size).toBe(2);
		expect(set.has(1)).toBe(true);
		expect(set.add(3)).toBe(set);
		expect([...set]).toEqual([1, 2, 3]);
		expect([...set.entries()]).toEqual([[1, 1], [2, 2], [3, 3]]);
		expect(set.delete(2)).toBe(true);
		expect(set.delete(2)).toBe(false);
		set.clear();
		expect(set.size).toBe(0);
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

	it("emits valueless slotted add and remove halves", () => {
		const member = { id: 1 };
		const state = createState({ set: new TrackedSet<typeof member>() });
		const heard = record(state);

		state.mutate((mutable) => mutable.set.add(member));
		state.mutate((mutable) => mutable.set.delete(member));

		const addition = heard[0]?.[0];
		const removal = heard[1]?.[0];

		expect(addition?.do.op).toBe("add");
		expect(addition?.do.path[0]).toBe("set");
		expect(isSameIdentity(addition?.do.path[1] as object, member)).toBe(true);
		expect(addition?.do.op === "add" && "slot" in addition.do ? addition.do.slot : undefined).toBe(0);
		expect(addition?.do && "value" in addition.do).toBe(false);
		expect(removal?.do).toMatchObject({ op: "remove", path: ["set", expect.any(Object)] });
		expect(removal?.undo.op === "add" && "value" in removal.undo).toBe(false);
	});

	it("emits member interiors at the member path", () => {
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
		expect(operation?.path[0]).toBe("set");
		expect(isSameIdentity(operation?.path[1] as object, member)).toBe(true);
		expect(operation?.path.slice(2)).toEqual(["profile", "count"]);
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
		applyOps(state, [...ops].reverse().map((pair) => pair.undo));
		expect([...state.op.unwrap().set]).toEqual(["a", "b"]);
		applyOps(state, ops.map((pair) => pair.do));
		expect([...state.op.unwrap().set]).toEqual(["b", "a"]);
	});

	it("preserves member identity through remove and restore", () => {
		const member = { id: 1 };
		const selection = new Map([[identify(member), "selected"]]);
		const state = createState({ set: new TrackedSet([member]) });
		const heard = record(state);

		state.mutate((mutable) => mutable.set.delete(member));
		const undo = heard[0]?.[0]?.undo;
		if (!undo) throw new Error("missing undo");
		applyOps(state, [undo]);

		const restored = [...state.op.unwrap().set][0];

		expect(restored && selection.get(identify(restored))).toBe("selected");
		expect(restored && isSameIdentity(restored, member)).toBe(true);
	});
});
