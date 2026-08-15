import { getVersion } from "valtio/vanilla";
import { subscribe } from "../subscribe";
import { transact } from "../transact/transact";
import { createMutableState } from "../createMutableState";
import { identify, isSameIdentity } from "../identity";
import { addressOf } from "../tracked/address";
import { TrackedDate } from "../tracked/trackedDate";
import { TrackedMap } from "../tracked/trackedMap";
import { TrackedSet } from "../tracked/trackedSet";
import { resolveRefValue } from "./applyMutations";
import { applyOperations } from "./applyOperations";
import { diffObjects } from "./diff";
import {
	createAssignMutation,
	createDeleteMutation,
	createLinkMutation,
	type LinkMutation,
	type Mutation,
	type Operation,
} from "./operation";
import { formatOperationPath } from "./path";

const asPair = (half: Mutation): Operation => ({ do: half, undo: half });

const record = <T extends object>(state: T): Array<Array<Operation>> => {
	const heard = new Array<Array<Operation>>();

	subscribe(state, (ops) => heard.push([...ops]));

	return heard;
};

describe("applyOperations: parent-sensitive atomic resolver", () => {
	it("applies mixed plain assign and delete in delivery order", () => {
		const state = createMutableState({
			document: { replaced: 1, removed: 2 } as { added?: number; replaced: number; removed?: number },
		});

		applyOperations(
			state,
			[
				asPair(createAssignMutation(["document", "added"], 3)),
				asPair(createAssignMutation(["document", "replaced"], 4)),
				asPair(createDeleteMutation(["document", "removed"])),
			],
			"do",
		);

		expect(state.document).toEqual({ added: 3, replaced: 4 });
	});

	it("distinguishes missing addresses from stored undefined", () => {
		const state = createMutableState<{ document: { value?: number } }>({ document: { value: undefined } });

		applyOperations(
			state,
			[
				asPair(createAssignMutation(["document", "value"], 1)),
				asPair(createAssignMutation(["document", "value"], undefined)),
			],
			"do",
		);
		expect(Object.hasOwn(state.document, "value")).toBe(true);
		applyOperations(state, [asPair(createDeleteMutation(["document", "value"]))], "do");
		expect(Object.hasOwn(state.document, "value")).toBe(false);
		applyOperations(state, [asPair(createAssignMutation(["document", "value"], undefined))], "do");
		expect(Object.hasOwn(state.document, "value")).toBe(true);
		expect(state.document.value).toBeUndefined();
	});

	it("re-applies assign and delete onto the same state with no throw", () => {
		const state = createMutableState<{ document: { value?: number; fresh?: number } }>({ document: { value: 1 } });
		const overwrite = createAssignMutation(["document", "value"], 2);
		const create = createAssignMutation(["document", "fresh"], 5);
		const remove = createDeleteMutation(["document", "value"]);

		applyOperations(state, [asPair(overwrite), asPair(overwrite), asPair(create), asPair(create)], "do");
		expect(state.document.value).toBe(2);
		expect(state.document.fresh).toBe(5);

		applyOperations(state, [asPair(remove), asPair(remove)], "do");
		expect(Object.hasOwn(state.document, "value")).toBe(false);
	});

	it("undoes a diff-produced assignment of undefined onto an absent key back to absence", () => {
		const ops = diffObjects({} as { value?: number }, { value: undefined });
		const state = createMutableState<{ value?: number }>({});

		applyOperations(state, ops, "do");
		expect(Object.hasOwn(state, "value")).toBe(true);
		expect(state.value).toBeUndefined();

		applyOperations(state, ops, "undo");
		expect(Object.hasOwn(state, "value")).toBe(false);
	});

	it("uses sparse array assign and delete with no shifts", () => {
		const state = createMutableState({ list: [1, 2, 3] });

		applyOperations(state, [asPair(createDeleteMutation(["list", 1]))], "do");
		expect(state.list).toHaveLength(3);
		expect(Object.hasOwn(state.list, 1)).toBe(false);
		applyOperations(state, [asPair(createAssignMutation(["list", 1], undefined))], "do");
		expect(Object.hasOwn(state.list, 1)).toBe(true);
		expect(state.list[2]).toBe(3);
	});

	it("applies array length and ordinary non-index string properties", () => {
		const initial = [1] as Array<number> & { label?: string };

		Object.defineProperty(initial, "label", { value: "a", enumerable: true, writable: true, configurable: true });

		const state = createMutableState({ list: initial });

		applyOperations(
			state,
			[
				asPair(createAssignMutation(["list", "length"], 3)),
				asPair(createAssignMutation(["list", "label"], "b")),
				asPair(createAssignMutation(["list", 2], 9)),
			],
			"do",
		);
		expect(state.list).toHaveLength(3);
		expect(state.list[2]).toBe(9);
		expect(state.list.label).toBe("b");
	});

	it("rejects invalid terminal operations before that operation mutates", () => {
		const state = createMutableState({
			count: 0,
			list: [1],
			map: new TrackedMap([["a", 1]]),
			set: new TrackedSet(["a"]),
			date: new TrackedDate(0),
		});

		expect(() => applyOperations(state, [asPair(createAssignMutation(["list", "0"], 2))], "do")).toThrow(
			"does not resolve",
		);
		expect(() => applyOperations(state, [asPair(createDeleteMutation(["list", "length"]))], "do")).toThrow(
			"does not resolve",
		);
		expect(Object.hasOwn(Object.prototype, "polluted")).toBe(false);
	});

	it("assign and delete at the empty path do not resolve", () => {
		const state = createMutableState({ count: 0 });

		expect(() => applyOperations(state, [asPair(createAssignMutation([], { count: 1 }))], "do")).toThrow(
			"opshot: / does not resolve to a supported operation address",
		);
		expect(() => applyOperations(state, [asPair(createDeleteMutation([]))], "do")).toThrow(
			"opshot: / does not resolve to a supported operation address",
		);
		expect(state.count).toBe(0);
	});

	it('formats the empty path as "/"', () => {
		expect(formatOperationPath([])).toBe("/");
	});

	it("rejects inherited setters without invoking them", () => {
		let calls = 0;

		Object.defineProperty(Object.prototype, "opshotInheritedSetter", {
			set: () => {
				calls += 1;
			},
			configurable: true,
		});

		try {
			const state = createMutableState<Record<string, number>>({});

			expect(() =>
				applyOperations(state, [asPair(createAssignMutation(["opshotInheritedSetter"], 1))], "do"),
			).toThrow("inherited accessor");
			expect(calls).toBe(0);
		} finally {
			Reflect.deleteProperty(Object.prototype, "opshotInheritedSetter");
		}
	});

	it("silently no-ops a hand-built assign onto a non-writable ride-along", () => {
		const locked = {} as { value: number };
		Object.defineProperty(locked, "value", { value: 1, enumerable: true, configurable: true, writable: false });
		const lockedState = createMutableState(locked);
		const heard = record(lockedState);

		expect(() => applyOperations(lockedState, [asPair(createAssignMutation(["value"], 2))], "do")).not.toThrow();
		expect(lockedState.value).toBe(1);
		expect(heard).toHaveLength(0);
	});

	it("re-deletes an address whose prototype carries an accessor without invoking it", () => {
		let calls = 0;

		Object.defineProperty(Object.prototype, "opshotAccessorAboveDelete", {
			set: () => {
				calls += 1;
			},
			get: () => undefined,
			configurable: true,
		});

		try {
			const state = createMutableState<Record<string, number>>({ present: 1 });
			const remove = createDeleteMutation(["opshotAccessorAboveDelete"]);

			applyOperations(state, [asPair(remove)], "do");
			applyOperations(state, [asPair(remove)], "do");

			expect(Object.hasOwn(state, "opshotAccessorAboveDelete")).toBe(false);
			expect(calls).toBe(0);
		} finally {
			Reflect.deleteProperty(Object.prototype, "opshotAccessorAboveDelete");
		}
	});

	it("preflights every copied half before applying any operation", () => {
		const state = createMutableState({ count: 0 });
		const copied = { ...createAssignMutation(["count"], 2) };

		applyOperations(state, [asPair(createAssignMutation(["count"], 1)), asPair(copied as Mutation)], "do");
		expect(state.count).toBe(2);
	});

	it("rejects bare halves; accepts branded-half Operation pairs", () => {
		const state = createMutableState({ count: 0 });
		const half = createAssignMutation(["count"], 1);

		expect(() => applyOperations(state, [half as unknown as Operation], "do")).toThrow(
			"applies operation pairs; pass the operation, with a direction",
		);

		applyOperations(state, [{ do: half, undo: createDeleteMutation(["count"]) }], "do");
		expect(state.count).toBe(1);

		expect(() => applyOperations(state, [{ do: half } as unknown as Operation], "do")).toThrow(
			"opshot: applyOperations applies well-formed { do, undo } pairs",
		);
	});

	it("restores Map membership through plain index/slots/count ops", () => {
		const state = createMutableState({
			map: new TrackedMap<string, number | undefined>([
				["a", 1],
				["b", 2],
			]),
		});
		const heard = record(state);

		transact(state, () => {
			state.map.delete("a");
			state.map.set("c", undefined);
		});

		const ops = heard[0] ?? [];

		applyOperations(state, ops, "undo");
		expect([...state.map]).toEqual([
			["a", 1],
			["b", 2],
		]);
		applyOperations(state, ops, "do");
		expect([...state.map]).toEqual([
			["b", 2],
			["c", undefined],
		]);
		expect(state.map.has("c")).toBe(true);
	});

	it("restores Set membership through plain index/slots/count ops", () => {
		const state = createMutableState({ set: new TrackedSet(["a", "b"]) });
		const heard = record(state);

		transact(state, () => {
			state.set.delete("a");
			state.set.add("c");
		});

		const ops = heard[0] ?? [];

		applyOperations(state, ops, "undo");
		expect([...state.set]).toEqual(["a", "b"]);
		applyOperations(state, ops, "do");
		expect([...state.set]).toEqual(["b", "c"]);
	});

	it("traverses Map key/value and Set member interiors through slots", () => {
		const key = { profile: { id: 1 } };
		const value = { count: 1 };
		const member = { count: 1 };
		const state = createMutableState({ map: new TrackedMap([[key, value]]), set: new TrackedSet([member]) });

		applyOperations(
			state,
			[
				asPair(createAssignMutation(["map", "slots", 0, 0, "profile", "id"], 2)),
				asPair(createAssignMutation(["map", "slots", 0, 1, "count"], 2)),
				asPair(createAssignMutation(["set", "slots", 0, 0, "count"], 2)),
			],
			"do",
		);

		const storedKey = [...state.map.keys()][0];
		const storedMember = [...state.set][0];

		expect(storedKey?.profile.id).toBe(2);
		expect(state.map.get(key)?.count).toBe(2);
		expect(storedMember?.count).toBe(2);
		expect(storedKey && isSameIdentity(storedKey, key)).toBe(true);
		expect(storedMember && isSameIdentity(storedMember, member)).toBe(true);
	});

	it("applies TrackedDate epochMs content separately from whole-target replacement", () => {
		const held = new TrackedDate(0);
		const state = createMutableState({ date: held });

		applyOperations(state, [asPair(createAssignMutation(["date", "epochMs"], 5))], "do");
		expect(state.date.getTime()).toBe(5);
		expect(isSameIdentity(state.date, held)).toBe(true);

		applyOperations(state, [asPair(createAssignMutation(["date"], new TrackedDate(10)))], "do");
		expect(state.date.getTime()).toBe(10);
		expect(state.date).toBeInstanceOf(TrackedDate);
		expect(isSameIdentity(state.date, held)).toBe(false);
	});

	it("restores removed targets with identity, exact content, and DAG aliases", () => {
		const shared = { count: 1 };
		const held: { kept: number; left: typeof shared; right: typeof shared; extra?: boolean } = {
			kept: 1,
			left: shared,
			right: shared,
		};
		const state = createMutableState<{ item?: typeof held }>({ item: held });
		const lookup = new Map([[identify(held), "selected"]]);
		const heard = record(state);

		transact(state, () => {
			delete state.item;
		});

		held.kept = 9;
		held.extra = true;
		shared.count = 9;

		const ops = heard[0] ?? [];
		if (ops.length === 0) throw new Error("missing undo");
		applyOperations(state, ops, "undo");

		const restored = state.item;
		if (!restored) throw new Error("missing restored item");
		expect(isSameIdentity(restored, held)).toBe(true);
		expect(lookup.get(identify(restored))).toBe("selected");
		expect(restored).toEqual({ kept: 1, left: { count: 1 }, right: { count: 1 } });
		expect(restored.left).toBe(restored.right);
		expect(isSameIdentity(restored.left, shared)).toBe(true);
	});

	it("round-trips clear, delete-readd, and slot displacement atomically", () => {
		const state = createMutableState({
			map: new TrackedMap([
				["a", 1],
				["b", 2],
			]),
			set: new TrackedSet(["a", "b"]),
		});
		const before = state;
		const heard = record(state);

		transact(state, () => {
			state.map.clear();
			state.map.set("b", 20);
			state.map.set("a", 10);
			state.set.clear();
			state.set.add("b");
			state.set.add("a");
		});

		const ops = heard[0] ?? [];
		const after = state;

		applyOperations(state, ops, "undo");
		expect([...state.map]).toEqual([...before.map]);
		expect([...state.set]).toEqual([...before.set]);
		applyOperations(state, ops, "do");
		expect([...state.map]).toEqual([...after.map]);
		expect([...state.set]).toEqual([...after.set]);
	});

	it("forwards replay meta while preserving ordered opaque history", () => {
		const state = createMutableState({ count: 0 });
		const recorded = new Array<Array<Operation>>();
		const persisted = new Array<Record<string, unknown>>();

		subscribe(state, (ops, meta) => {
			if ((meta as any)?.replay !== true) recorded.push([...ops]);
		});
		subscribe(state, (_ops, meta) => {
			persisted.push(meta as Record<string, unknown>);
		});

		transact(state, () => {
			state.count = 1;
		});
		const ops = recorded[0];
		if (!ops) throw new Error("missing history");
		applyOperations(state, ops, "undo", { replay: true });

		expect(state.count).toBe(0);
		expect(recorded).toHaveLength(1);
		expect(persisted).toEqual([undefined, { replay: true }]);
	});

	it("applies public diff halves exactly", () => {
		const state = createMutableState({ count: 0 });
		const ops = diffObjects({ count: 0 }, { count: 2 });

		applyOperations(state, ops, "do");
		expect(state.count).toBe(2);
		applyOperations(state, ops, "undo");
		expect(state.count).toBe(0);
	});

	it("restores a whole TrackedMap replace under a plain parent", () => {
		const keyA = { id: "a" };
		const keyB = { id: "b" };
		const valueA = { label: "A" };
		const valueB = { label: "B" };
		const original = new TrackedMap([
			[keyA, valueA],
			[keyB, valueB],
		]);
		const state = createMutableState({ map: original });
		const selection = new Map([
			[identify(keyA), "a"],
			[identify(keyB), "b"],
		]);
		const heard = record(state);
		const beforeEntries = [...state.map];

		transact(state, () => {
			state.map = new TrackedMap([[{ id: "z" }, { label: "Z" }]]);
		});

		const ops = heard[0] ?? [];

		expect(ops).toHaveLength(1);
		expect(ops[0]?.do).toMatchObject({ verb: "assign", path: ["map"] });
		expect(isSameIdentity(state.map, original)).toBe(false);

		original.delete(keyA);
		original.set(keyB, { label: "stomped-value" });
		original.set({ id: "stomp" }, { label: "stomped" });
		valueA.label = "mutated-while-detached";

		const undoHeard: Array<Array<Operation>> = [];

		subscribe(state, (next) => undoHeard.push([...next]));
		applyOperations(state, ops, "undo");

		const restored = state.map;
		const restoredEntries = [...restored];

		expect(isSameIdentity(restored, original)).toBe(true);
		expect(restored.size).toBe(2);
		expect(restoredEntries.map(([key, value]) => [key.id, value.label])).toEqual([
			["a", "A"],
			["b", "B"],
		]);
		expect(restored.get(keyA)?.label).toBe("A");
		expect(restored.get(keyB)?.label).toBe("B");
		expect(restoredEntries[0]?.[0] && selection.get(identify(restoredEntries[0][0]))).toBe("a");
		expect(restoredEntries[1]?.[0] && selection.get(identify(restoredEntries[1][0]))).toBe("b");
		expect(restoredEntries[0]?.[1] && isSameIdentity(restoredEntries[0][1], valueA)).toBe(true);
		expect(restoredEntries[1]?.[1] && isSameIdentity(restoredEntries[1][1], valueB)).toBe(true);
		expect(undoHeard.length).toBeGreaterThan(0);

		const afterUndo = [...restored].map(([key, value]) => [key.id, value.label]);

		applyOperations(state, ops, "do");
		expect([...state.map]).toEqual([[{ id: "z" }, { label: "Z" }]]);
		applyOperations(state, ops, "undo");
		expect([...state.map].map(([key, value]) => [key.id, value.label])).toEqual(afterUndo);
		expect(isSameIdentity(state.map, original)).toBe(true);
		expect(beforeEntries.map(([key]) => identify(key as object))).toEqual(
			[...state.map].map(([key]) => identify(key as object)),
		);
	});

	it("restores a whole TrackedMap replace nested as a Map value", () => {
		const outerKey = { outer: true };
		const keyA = { id: "a" };
		const keyB = { id: "b" };
		const valueA = { label: "A" };
		const valueB = { label: "B" };
		const inner = new TrackedMap([
			[keyA, valueA],
			[keyB, valueB],
		]);
		const state = createMutableState({ outer: new TrackedMap([[outerKey, inner]]) });
		const selection = new Map([
			[identify(keyA), "a"],
			[identify(keyB), "b"],
		]);
		const heard = record(state);

		transact(state, () => {
			state.outer.set(outerKey, new TrackedMap([[{ id: "z" }, { label: "Z" }]]));
		});

		const ops = heard[0] ?? [];

		expect(ops.length).toBeGreaterThan(0);

		inner.delete(keyA);
		inner.set(keyB, { label: "stomped-value" });
		inner.set({ id: "stomp" }, { label: "stomped" });
		valueA.label = "mutated-while-detached";

		applyOperations(state, ops, "undo");

		const restored = state.outer.get(outerKey);

		if (!restored) throw new Error("missing restored inner map");

		const restoredEntries = [...restored];

		expect(isSameIdentity(restored, inner)).toBe(true);
		expect(restored.size).toBe(2);
		expect(restoredEntries.map(([key, value]) => [key.id, value.label])).toEqual([
			["a", "A"],
			["b", "B"],
		]);
		expect(restored.get(keyA)?.label).toBe("A");
		expect(restored.get(keyB)?.label).toBe("B");
		expect(restoredEntries[0]?.[0] && selection.get(identify(restoredEntries[0][0]))).toBe("a");
		expect(restoredEntries[1]?.[0] && selection.get(identify(restoredEntries[1][0]))).toBe("b");
		expect(restoredEntries[0]?.[1] && isSameIdentity(restoredEntries[0][1], valueA)).toBe(true);
		expect(restoredEntries[1]?.[1] && isSameIdentity(restoredEntries[1][1], valueB)).toBe(true);

		applyOperations(state, ops, "do");
		expect([...state.outer.get(outerKey)!]).toEqual([[{ id: "z" }, { label: "Z" }]]);
		applyOperations(state, ops, "undo");
		expect([...state.outer.get(outerKey)!].map(([key, value]) => [key.id, value.label])).toEqual([
			["a", "A"],
			["b", "B"],
		]);
		expect(isSameIdentity(state.outer.get(outerKey)!, inner)).toBe(true);
	});

	it("restores a whole TrackedSet replace under a plain parent", () => {
		const memberA = { id: "a" };
		const memberB = { id: "b" };
		const original = new TrackedSet([memberA, memberB]);
		const state = createMutableState({ set: original });
		const selection = new Map([
			[identify(memberA), "a"],
			[identify(memberB), "b"],
		]);
		const heard = record(state);

		transact(state, () => {
			state.set = new TrackedSet([{ id: "z" }]);
		});

		const ops = heard[0] ?? [];

		expect(ops).toHaveLength(1);
		expect(ops[0]?.do).toMatchObject({ verb: "assign", path: ["set"] });

		original.delete(memberA);
		original.add({ id: "stomp" });
		memberA.id = "mutated-while-detached";

		applyOperations(state, ops, "undo");

		const restored = state.set;
		const restoredMembers = [...restored];

		expect(isSameIdentity(restored, original)).toBe(true);
		expect(restored.size).toBe(2);
		expect(restoredMembers.map((member) => member.id)).toEqual(["a", "b"]);
		expect(restored.has(memberA)).toBe(true);
		expect(restored.has(memberB)).toBe(true);
		expect(restoredMembers[0] && selection.get(identify(restoredMembers[0]))).toBe("a");
		expect(restoredMembers[1] && selection.get(identify(restoredMembers[1]))).toBe("b");
		expect(restoredMembers[0] && isSameIdentity(restoredMembers[0], memberA)).toBe(true);
		expect(restoredMembers[1] && isSameIdentity(restoredMembers[1], memberB)).toBe(true);

		applyOperations(state, ops, "do");
		expect([...state.set].map((member) => member.id)).toEqual(["z"]);
		applyOperations(state, ops, "undo");
		expect([...state.set].map((member) => member.id)).toEqual(["a", "b"]);
		expect(isSameIdentity(state.set, original)).toBe(true);
	});

	it("keeps identify()-keyed consumers alive across a whole plain-container replace", () => {
		const itemA = { id: "a" };
		const itemB = { id: "b" };
		const container = { items: [itemA, itemB] };
		const state = createMutableState({ document: container });
		const selection = new Map([
			[identify(itemA), "selected-a"],
			[identify(itemB), "selected-b"],
		]);
		const heard = record(state);

		transact(state, () => {
			state.document = { items: [{ id: "z" }] };
		});

		const ops = heard[0] ?? [];

		expect(ops).toHaveLength(1);
		expect(ops[0]?.do).toMatchObject({ verb: "assign", path: ["document"] });

		applyOperations(state, ops, "undo");

		const restored = state.document;

		expect(selection.get(identify(restored.items[0]!))).toBe("selected-a");
		expect(selection.get(identify(restored.items[1]!))).toBe("selected-b");
		expect(isSameIdentity(restored.items[0]!, itemA)).toBe(true);
		expect(isSameIdentity(restored.items[1]!, itemB)).toBe(true);
	});

	it("restores DAG aliases inside whole-container replace contents to shared storage", () => {
		const shared = { count: 1 };
		const container = { left: shared, right: shared };
		const state = createMutableState({ document: container });
		const heard = record(state);

		transact(state, () => {
			state.document = { left: { count: 9 }, right: { count: 9 } };
		});

		const ops = heard[0] ?? [];

		applyOperations(state, ops, "undo");

		const restored = state.document;

		expect(isSameIdentity(restored.left, restored.right)).toBe(true);
		expect(isSameIdentity(restored.left, shared)).toBe(true);
		expect(restored.left.count).toBe(1);
		expect(restored.right.count).toBe(1);
	});

	it("retains the pre-mutation container target after undoing a whole-container replace", () => {
		const container = { count: 1 };
		const state = createMutableState({ document: container });
		const heard = record(state);

		transact(state, () => {
			state.document = { count: 2 };
		});

		const ops = heard[0] ?? [];

		expect(isSameIdentity(state.document, container)).toBe(false);

		applyOperations(state, ops, "undo");

		expect(isSameIdentity(state.document, container)).toBe(true);
		expect(state.document.count).toBe(1);
	});

	it("round-trips a whole-container replace nested under another whole-container replace", () => {
		const inner = { value: 1 };
		const outer = { nested: inner };
		const state = createMutableState({ root: outer });
		const heard = record(state);

		transact(state, () => {
			state.root = { nested: { value: 2 } };
		});

		const firstOps = heard[0] ?? [];

		expect(firstOps).toHaveLength(1);
		expect(firstOps[0]?.do).toMatchObject({ verb: "assign", path: ["root"] });

		transact(state, () => {
			state.root = { nested: { value: 3 } };
		});

		const secondOps = heard[1] ?? [];

		expect(secondOps).toHaveLength(1);
		expect(secondOps[0]?.do).toMatchObject({ verb: "assign", path: ["root"] });

		applyOperations(state, secondOps, "undo");
		expect(state.root.nested.value).toBe(2);

		applyOperations(state, firstOps, "undo");
		expect(state.root.nested.value).toBe(1);
		expect(isSameIdentity(state.root, outer)).toBe(true);
		expect(isSameIdentity(state.root.nested, inner)).toBe(true);

		applyOperations(state, firstOps, "do");
		expect(state.root.nested.value).toBe(2);

		applyOperations(state, secondOps, "do");
		expect(state.root.nested.value).toBe(3);
	});

	it("applies an atomic Map index address write", () => {
		const key = { id: 1 };
		const state = createMutableState({ map: new TrackedMap([[key, 1]]) });
		const addr = addressOf(key);

		applyOperations(state, [asPair(createAssignMutation(["map", "slots", 0], [key, 9] as const))], "do");
		expect(state.map.get(key)).toBe(9);
		applyOperations(
			state,
			[
				asPair(createDeleteMutation(["map", "index", addr])),
				asPair(createAssignMutation(["map", "slots", 0], null)),
				asPair(createAssignMutation(["map", "count"], 0)),
			],
			"do",
		);
		expect(state.map.size).toBe(0);
		expect(state.map.has(key)).toBe(false);
	});
});

it("applies undo halves in reverse delivery order for overlapping paths", () => {
	const state = createMutableState({ a: 0 });
	const ops: Array<Operation> = [
		{ do: createAssignMutation(["a"], 1), undo: createAssignMutation(["a"], 0) },
		{ do: createAssignMutation(["a"], 2), undo: createAssignMutation(["a"], 1) },
	];

	applyOperations(state, ops, "do");
	expect(state.a).toBe(2);

	applyOperations(state, ops, "undo");
	expect(state.a).toBe(0);
});

it("applies a mixed assign and delete stream in delivery order under do", () => {
	const state = createMutableState({
		document: { kept: 1, gone: 2 } as { kept: number; gone?: number; added?: number },
	});
	const ops: Array<Operation> = [
		{ do: createAssignMutation(["document", "added"], 3), undo: createDeleteMutation(["document", "added"]) },
		{ do: createAssignMutation(["document", "kept"], 4), undo: createAssignMutation(["document", "kept"], 1) },
		{ do: createDeleteMutation(["document", "gone"]), undo: createAssignMutation(["document", "gone"], 2) },
	];

	applyOperations(state, ops, "do");
	expect(state.document).toEqual({ kept: 4, added: 3 });
});

it("round-trips do then undo for a multi-op stream", () => {
	const state = createMutableState({ a: 0, b: 0 });
	const ops: Array<Operation> = [
		{ do: createAssignMutation(["a"], 1), undo: createAssignMutation(["a"], 0) },
		{ do: createAssignMutation(["b"], 2), undo: createAssignMutation(["b"], 0) },
	];

	applyOperations(state, ops, "do");
	expect(state).toMatchObject({ a: 1, b: 2 });
	applyOperations(state, ops, "undo");
	expect(state).toMatchObject({ a: 0, b: 0 });
	applyOperations(state, ops, "do");
	expect(state).toMatchObject({ a: 1, b: 2 });
});

describe("applyOperations: resolution is the pollution defence", () => {
	it("refuses an absent own constructor exactly as it refuses an absent ordinary key", () => {
		const state = createMutableState<{ a: number }>({ a: 1 });

		// The pollution ladder itself: `constructor` then `prototype`, the shape a reserved-path
		// rule used to reject before emission. Resolution alone must now refuse it.
		expect(() =>
			applyOperations(
				state,
				[asPair(createAssignMutation(["constructor", "prototype", "polluted"], "PWNED"))],
				"do",
			),
		).toThrow("does not resolve");
		expect(() =>
			applyOperations(state, [asPair(createDeleteMutation(["constructor", "prototype", "polluted"]))], "do"),
		).toThrow("does not resolve");
		expect(() =>
			applyOperations(state, [asPair(createAssignMutation(["constructor", "polluted"], "PWNED"))], "do"),
		).toThrow("does not resolve");
		expect(() => applyOperations(state, [asPair(createAssignMutation(["zzz", "added"], 1))], "do")).toThrow(
			"does not resolve",
		);

		expect(Object.prototype).not.toHaveProperty("polluted");
		expect(Object).not.toHaveProperty("polluted");
		expect(Object.prototype).not.toHaveProperty("prototype");
		expect({}).not.toHaveProperty("polluted");
	});

	it("applies an assembled constructor path where the own key is present, refuses it where absent", () => {
		const state = createMutableState<{ h: { constructor: { note: number; prototype?: object } } }>({
			h: { constructor: { note: 1 } },
		});
		const heard = record(state);

		transact(state, () => {
			state.h.constructor.prototype = { x: 1 };
		});

		const ops = heard.flat();

		expect(ops.map((op) => op.do.path)).toEqual([["h", "constructor", "prototype"]]);

		applyOperations(state, ops, "undo");
		expect(Object.hasOwn(state.h.constructor, "prototype")).toBe(false);

		applyOperations(state, ops, "do");
		expect(state.h.constructor.prototype).toEqual({ x: 1 });

		const withoutOwnConstructor = createMutableState<{ h: Record<string, unknown> }>({ h: {} });

		expect(() => applyOperations(withoutOwnConstructor, ops, "do")).toThrow("does not resolve");

		expect(Object.prototype).not.toHaveProperty("x");
		expect({}).not.toHaveProperty("x");
	});

	it("refuses a hand-built __proto__ path through the inherited-accessor guard", () => {
		const state = createMutableState<{ a: number }>({ a: 1 });

		expect(() =>
			applyOperations(state, [asPair(createAssignMutation(["__proto__"], { polluted: "PWNED" }))], "do"),
		).toThrow("inherited accessor");
		expect(Object.prototype).not.toHaveProperty("polluted");
		expect(Reflect.getPrototypeOf(state)).toBe(Object.prototype);
		expect(diffObjects({}, JSON.parse('{"__proto__": {"polluted": true}}') as object)).toEqual([]);
	});

	it("keeps an own __proto__ ride-along out of the record and restores it at its original descriptor", () => {
		const roundTrip = (rideAlong: PropertyDescriptor): void => {
			const container = { a: 1 };

			Object.defineProperty(container, "__proto__", rideAlong);

			const state = createMutableState<{ held: { a: number } }>({ held: container });
			const before = Reflect.getOwnPropertyDescriptor(state.held, "__proto__");
			const heard = record(state);

			transact(state, () => {
				state.held = { a: 2 };
			});

			const ops = heard.flat();

			for (const op of ops) {
				if (op.undo.verb !== "assign") continue;

				expect(Object.getOwnPropertyNames(op.undo.value as object)).not.toContain("__proto__");
			}

			applyOperations(state, ops, "undo");

			expect(state.held.a).toBe(1);
			expect(Reflect.getOwnPropertyDescriptor(state.held, "__proto__")).toEqual(before);

			applyOperations(state, ops, "do");

			expect(state.held.a).toBe(2);
			expect(Reflect.getPrototypeOf(state.held)).toBe(Object.prototype);
			expect(Object.prototype).not.toHaveProperty("a");
		};

		roundTrip({ value: "poison", writable: false, enumerable: false, configurable: false });
		roundTrip({ value: "poison", writable: false, enumerable: false, configurable: true });
	});

	it("leaves symbol-keyed and non-enumerable ride-alongs alone through a wholesale-restore undo that removes keys", () => {
		const symbolKey = Symbol("ride");
		const held: Record<string, unknown> = Object.fromEntries(
			Array.from({ length: 80 }, (_, index) => [`k${String(index)}`, index]),
		);

		Object.defineProperty(held, "hidden", {
			value: "secret",
			enumerable: false,
			writable: true,
			configurable: true,
		});
		Object.defineProperty(held, symbolKey, {
			value: "symbol",
			enumerable: true,
			writable: true,
			configurable: true,
		});

		const state = createMutableState({ held });
		const heard = record(state);

		transact(state, () => {
			for (let index = 0; index < 80; index++) state.held[`k${String(index)}`] = index + 1000;
			state.held.extra = "added";
		});

		const ops = heard[0] ?? [];

		expect(ops).toHaveLength(1);
		expect(ops[0]?.do).toMatchObject({ verb: "assign", path: ["held"] });
		expect(Object.hasOwn(state.held, "extra")).toBe(true);

		const lateSymbol = Symbol("late");

		Reflect.set(held, "hidden", "post-hidden");
		Reflect.set(held, symbolKey, "post-symbol");
		Object.defineProperty(held, lateSymbol, {
			value: "late",
			enumerable: true,
			writable: true,
			configurable: true,
		});

		const hiddenMutated = Reflect.getOwnPropertyDescriptor(state.held, "hidden");
		const symbolMutated = Reflect.getOwnPropertyDescriptor(state.held, symbolKey);
		const lateMutated = Reflect.getOwnPropertyDescriptor(state.held, lateSymbol);

		applyOperations(state, ops, "undo");

		expect(Reflect.getOwnPropertyDescriptor(state.held, "hidden")).toEqual(hiddenMutated);
		expect(Reflect.getOwnPropertyDescriptor(state.held, symbolKey)).toEqual(symbolMutated);
		expect(Reflect.getOwnPropertyDescriptor(state.held, lateSymbol)).toEqual(lateMutated);
		expect(Object.hasOwn(state.held, "extra")).toBe(false);
		expect(state.held.k0).toBe(0);
		expect(state.held.k79).toBe(79);

		applyOperations(state, ops, "do");

		expect(Reflect.getOwnPropertyDescriptor(state.held, "hidden")).toEqual(hiddenMutated);
		expect(Reflect.getOwnPropertyDescriptor(state.held, symbolKey)).toEqual(symbolMutated);
		expect(Reflect.getOwnPropertyDescriptor(state.held, lateSymbol)).toEqual(lateMutated);
		expect(state.held.extra).toBe("added");
	});

	it("does not re-assign a child that is already the recorded target, and still restores its interior", () => {
		const state = createMutableState<{ tree: { child?: { n: number; deep?: { m: number } } } }>({
			tree: { child: { n: 1, deep: { m: 1 } } },
		});
		const recorded = new Array<Operation>();

		subscribe(state, (ops) => recorded.push(...ops));

		const childBefore = state.tree.child;

		transact(state, () => {
			state.tree = {};
		});

		const ops = [...recorded];

		applyOperations(state, ops, "undo");

		expect(state.tree.child?.n).toBe(1);
		expect(state.tree.child?.deep?.m).toBe(1);
		expect(isSameIdentity(state.tree.child as object, childBefore as object)).toBe(true);

		const replayed = new Array<Operation>();

		subscribe(state, (ops) => replayed.push(...ops));

		applyOperations(state, ops, "undo");

		expect(replayed).toHaveLength(0);
	});

	it("bumps no version when the slot already holds the recorded target", () => {
		const state = createMutableState<{ tree: { child?: { n: number } } }>({ tree: { child: { n: 1 } } });
		const recorded = new Array<Operation>();

		subscribe(state, (ops) => recorded.push(...ops));

		transact(state, () => {
			state.tree = {};
		});

		const ops = [...recorded];

		applyOperations(state, ops, "undo");

		const settled = getVersion(state);

		applyOperations(state, ops, "undo");

		expect(getVersion(state)).toBe(settled);
	});
});

describe("applyOperations: link halves", () => {
	it("resolves a ref read-only to the live object at that path", () => {
		const state = createMutableState({ shared: { n: 1 }, nested: { deep: { n: 2 } } });

		const link = ["alias"];

		expect(resolveRefValue(state, ["shared"], link)).toBe(state.shared);
		expect(resolveRefValue(state, ["nested", "deep"], link)).toBe(state.nested.deep);
		expect(() => resolveRefValue(state, ["missing"], link)).toThrow("does not resolve");
		expect(() => resolveRefValue(state, ["shared", "n"], link)).toThrow("resolves to a non-object");
	});

	it("resolves an empty ref to the apply write-proxy", () => {
		const state = createMutableState<{ shared: { n: number }; alias?: object }>({ shared: { n: 1 } });

		expect(resolveRefValue(state, [], ["alias"])).toBe(state);

		applyOperations(state, [{ do: createLinkMutation(["alias"], []), undo: createDeleteMutation(["alias"]) }], "do");

		expect(state.alias).toBe(state);
	});

	it("establishes sharing on a plain target", () => {
		const state = createMutableState<{ shared: { n: number }; alias?: { n: number } }>({ shared: { n: 1 } });

		applyOperations(
			state,
			[{ do: createLinkMutation(["alias"], ["shared"]), undo: createDeleteMutation(["alias"]) }],
			"do",
		);

		expect(state.alias).toBe(state.shared);
		expect(state.alias?.n).toBe(1);
	});

	it("applies a spread or JSON-copied link half", () => {
		const state = createMutableState<{ shared: { n: number }; alias?: { n: number } }>({ shared: { n: 1 } });
		const branded = createLinkMutation(["alias"], ["shared"]);
		const spread = { ...branded };
		const json = JSON.parse(JSON.stringify(branded)) as LinkMutation;

		applyOperations(state, [{ do: spread as LinkMutation, undo: createDeleteMutation(["alias"]) }], "do");
		expect(state.alias).toBe(state.shared);

		applyOperations(state, [{ do: createDeleteMutation(["alias"]), undo: createDeleteMutation(["alias"]) }], "do");
		expect(Object.hasOwn(state, "alias")).toBe(false);

		applyOperations(state, [{ do: json, undo: createDeleteMutation(["alias"]) }], "do");
		expect(state.alias).toBe(state.shared);
	});

	it("undoes a new-key link by deleting", () => {
		const state = createMutableState<{ shared: { n: number }; alias?: { n: number } }>({ shared: { n: 1 } });
		const ops: Array<Operation> = [
			{ do: createLinkMutation(["alias"], ["shared"]), undo: createDeleteMutation(["alias"]) },
		];

		applyOperations(state, ops, "do");
		expect(state.alias).toBe(state.shared);

		applyOperations(state, ops, "undo");
		expect(Object.hasOwn(state, "alias")).toBe(false);
		expect(state.shared.n).toBe(1);
	});

	it("applies a mixed values-then-links batch in do and preserves the target-path invariant under undo", () => {
		const state = createMutableState<{
			target?: { id: number };
			other?: { id: number };
			alias?: { id: number };
		}>({});
		const ops: Array<Operation> = [
			{ do: createAssignMutation(["target"], { id: 1 }), undo: createDeleteMutation(["target"]) },
			{ do: createAssignMutation(["other"], { id: 2 }), undo: createDeleteMutation(["other"]) },
			{ do: createLinkMutation(["alias"], ["target"]), undo: createDeleteMutation(["alias"]) },
		];

		applyOperations(state, ops, "do");
		expect(state.alias).toBe(state.target);
		expect(state.other?.id).toBe(2);

		applyOperations(state, ops, "undo");
		expect(state).toEqual({});
	});

	it("round-trips a link whose undo is itself a link", () => {
		const state = createMutableState<{ a: { n: number }; b: { n: number }; alias: { n: number } | null }>({
			a: { n: 1 },
			b: { n: 2 },
			alias: null,
		});

		applyOperations(
			state,
			[{ do: createLinkMutation(["alias"], ["a"]), undo: createAssignMutation(["alias"], null) }],
			"do",
		);
		expect(state.alias).toBe(state.a);

		const overwrite: Operation = {
			do: createLinkMutation(["alias"], ["b"]),
			undo: createLinkMutation(["alias"], ["a"]),
		};

		applyOperations(state, [overwrite], "do");
		expect(state.alias).toBe(state.b);

		applyOperations(state, [overwrite], "undo");
		expect(state.alias).toBe(state.a);
	});

	it("refuses an unresolvable ref naming both paths", () => {
		const state = createMutableState<{ shared: { n: number } }>({ shared: { n: 1 } });

		expect(() =>
			applyOperations(
				state,
				[{ do: createLinkMutation(["alias"], ["missing"]), undo: createDeleteMutation(["alias"]) }],
				"do",
			),
		).toThrow("link at /alias with ref /missing does not resolve");
	});

	it("refuses a ref that resolves to a non-object naming both paths", () => {
		const state = createMutableState<{ count: number; alias?: object }>({ count: 1 });

		expect(() =>
			applyOperations(
				state,
				[{ do: createLinkMutation(["alias"], ["count"]), undo: createDeleteMutation(["alias"]) }],
				"do",
			),
		).toThrow("link at /alias with ref /count resolves to a non-object");
	});

	it("refuses a link addressed at array length naming both paths", () => {
		const state = createMutableState<{ list: Array<number>; shared: { n: number } }>({
			list: [1],
			shared: { n: 1 },
		});

		expect(() =>
			applyOperations(
				state,
				[
					{
						do: createLinkMutation(["list", "length"], ["shared"]),
						undo: createDeleteMutation(["list", "length"]),
					},
				],
				"do",
			),
		).toThrow("link at /list/length with ref /shared cannot address array length");
	});

	it("applies a spread assign half and a well-formed unbranded link half", () => {
		const state = createMutableState<{ shared: { n: number }; count: number; alias?: { n: number } }>({
			shared: { n: 1 },
			count: 0,
		});
		const copiedAssign = { ...createAssignMutation(["count"], 2) };
		const copiedLink = { ...createLinkMutation(["alias"], ["shared"]) };

		applyOperations(state, [{ do: copiedAssign as Mutation, undo: createDeleteMutation(["count"]) }], "do");
		applyOperations(state, [{ do: copiedLink as LinkMutation, undo: createDeleteMutation(["alias"]) }], "do");
		expect(state.count).toBe(2);
		expect(state.alias).toBe(state.shared);
	});

	it("applies JSON.parse of JSON.stringify of a branded assign and delete pair", () => {
		const state = createMutableState<{ count: number; gone?: number }>({ count: 0, gone: 1 });
		const ops = [
			{ do: createAssignMutation(["count"], 2), undo: createAssignMutation(["count"], 0) },
			{ do: createDeleteMutation(["gone"]), undo: createAssignMutation(["gone"], 1) },
		];

		applyOperations(state, JSON.parse(JSON.stringify(ops)) as Array<Operation>, "do");
		expect(state.count).toBe(2);
		expect(Object.hasOwn(state, "gone")).toBe(false);
	});
});
