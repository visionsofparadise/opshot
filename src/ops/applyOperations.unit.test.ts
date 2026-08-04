import { getVersion } from "valtio/vanilla";
import { subscribe } from "../subscribe";
import { transact } from "../transact";
import { createMutableState } from "../createMutableState";
import { identify, isSameIdentity } from "../identity";
import { addressOf } from "../tracked/address";
import { TrackedDate } from "../tracked/trackedDate";
import { TrackedMap } from "../tracked/trackedMap";
import { TrackedSet } from "../tracked/trackedSet";
import { applyOperations } from "./applyOperations";
import { diffObjects } from "./diff";
import { createAssignMutation, createDeleteMutation, type Operation, type Mutation } from "./operation";

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

		applyOperations(state, [
			createAssignMutation(["document", "added"], 3),
			createAssignMutation(["document", "replaced"], 4),
			createDeleteMutation(["document", "removed"]),
		]);

		expect(state.document).toEqual({ added: 3, replaced: 4 });
	});

	it("distinguishes missing addresses from stored undefined", () => {
		const state = createMutableState<{ document: { value?: number } }>({ document: { value: undefined } });

		applyOperations(state, [
			createAssignMutation(["document", "value"], 1),
			createAssignMutation(["document", "value"], undefined),
		]);
		expect(Object.hasOwn(state.document, "value")).toBe(true);
		applyOperations(state, [createDeleteMutation(["document", "value"])]);
		expect(Object.hasOwn(state.document, "value")).toBe(false);
		applyOperations(state, [createAssignMutation(["document", "value"], undefined)]);
		expect(Object.hasOwn(state.document, "value")).toBe(true);
		expect(state.document.value).toBeUndefined();
	});

	it("re-applies assign and delete onto the same state with no throw", () => {
		const state = createMutableState<{ document: { value?: number; fresh?: number } }>({ document: { value: 1 } });
		const overwrite = createAssignMutation(["document", "value"], 2);
		const create = createAssignMutation(["document", "fresh"], 5);
		const remove = createDeleteMutation(["document", "value"]);

		applyOperations(state, [overwrite, overwrite, create, create]);
		expect(state.document.value).toBe(2);
		expect(state.document.fresh).toBe(5);

		applyOperations(state, [remove, remove]);
		expect(Object.hasOwn(state.document, "value")).toBe(false);
	});

	it("undoes a diff-produced assignment of undefined onto an absent key back to absence", () => {
		const ops = diffObjects({} as { value?: number }, { value: undefined });
		const state = createMutableState<{ value?: number }>({});

		applyOperations(
			state,
			ops.map((pair) => pair.do),
		);
		expect(Object.hasOwn(state, "value")).toBe(true);
		expect(state.value).toBeUndefined();

		applyOperations(state, ops.map((pair) => pair.undo).reverse());
		expect(Object.hasOwn(state, "value")).toBe(false);
	});

	it("uses sparse array assign and delete with no shifts", () => {
		const state = createMutableState({ list: [1, 2, 3] });

		applyOperations(state, [createDeleteMutation(["list", 1])]);
		expect(state.list).toHaveLength(3);
		expect(Object.hasOwn(state.list, 1)).toBe(false);
		applyOperations(state, [createAssignMutation(["list", 1], undefined)]);
		expect(Object.hasOwn(state.list, 1)).toBe(true);
		expect(state.list[2]).toBe(3);
	});

	it("applies array length and ordinary non-index string properties", () => {
		const initial = [1] as Array<number> & { label?: string };

		Object.defineProperty(initial, "label", { value: "a", enumerable: true, writable: true, configurable: true });

		const state = createMutableState({ list: initial });

		applyOperations(state, [
			createAssignMutation(["list", "length"], 3),
			createAssignMutation(["list", "label"], "b"),
			createAssignMutation(["list", 2], 9),
		]);
		expect(state.list).toHaveLength(3);
		expect(state.list[2]).toBe(9);
		expect(state.list.label).toBe("b");
	});

	it("rejects root and invalid terminal operations before that operation mutates", () => {
		const state = createMutableState({
			count: 0,
			list: [1],
			map: new TrackedMap([["a", 1]]),
			set: new TrackedSet(["a"]),
			date: new TrackedDate(0),
		});

		expect(() => applyOperations(state, [createAssignMutation([], {})])).toThrow("root operations");
		expect(() => applyOperations(state, [createAssignMutation(["list", "0"], 2)])).toThrow("does not resolve");
		expect(() => applyOperations(state, [createDeleteMutation(["list", "length"])])).toThrow("does not resolve");
		expect(Object.hasOwn(Object.prototype, "polluted")).toBe(false);
	});

	it("rejects inherited setters without invoking them and detects failed writes", () => {
		let calls = 0;

		Object.defineProperty(Object.prototype, "opshotInheritedSetter", {
			set: () => {
				calls += 1;
			},
			configurable: true,
		});

		try {
			const state = createMutableState<Record<string, number>>({});

			expect(() => applyOperations(state, [createAssignMutation(["opshotInheritedSetter"], 1)])).toThrow(
				"inherited accessor",
			);
			expect(calls).toBe(0);
		} finally {
			Reflect.deleteProperty(Object.prototype, "opshotInheritedSetter");
		}

		const locked = {} as { value: number };
		Object.defineProperty(locked, "value", { value: 1, enumerable: true, configurable: true, writable: false });
		const lockedState = createMutableState(locked);

		expect(() => applyOperations(lockedState, [createAssignMutation(["value"], 2)])).toThrow(
			"replay could not restore value",
		);
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

			applyOperations(state, [remove]);
			applyOperations(state, [remove]);

			expect(Object.hasOwn(state, "opshotAccessorAboveDelete")).toBe(false);
			expect(calls).toBe(0);
		} finally {
			Reflect.deleteProperty(Object.prototype, "opshotAccessorAboveDelete");
		}
	});

	it("preflights every copied half before applying any operation", () => {
		const state = createMutableState({ count: 0 });
		const copied = { ...createAssignMutation(["count"], 2) };

		expect(() => applyOperations(state, [createAssignMutation(["count"], 1), copied as Mutation])).toThrow(
			"this op is a copy",
		);
		expect(state.count).toBe(0);
	});

	it("rejects full Operation envelopes; pass op.do or op.undo halves", () => {
		const state = createMutableState({ count: 0 });
		const half = createAssignMutation(["count"], 1);

		expect(() => applyOperations(state, [{ do: half, undo: half } as unknown as Mutation])).toThrow(
			"opshot: applyOperations applies operation halves; pass op.do or op.undo.",
		);
		expect(() => applyOperations(state, [{ do: half } as unknown as Mutation])).toThrow(
			"opshot: applyOperations applies operation halves; pass op.do or op.undo.",
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

		applyOperations(
			state,
			[...ops].reverse().map((pair) => pair.undo),
		);
		expect([...state.map]).toEqual([
			["a", 1],
			["b", 2],
		]);
		applyOperations(
			state,
			ops.map((pair) => pair.do),
		);
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

		applyOperations(
			state,
			[...ops].reverse().map((pair) => pair.undo),
		);
		expect([...state.set]).toEqual(["a", "b"]);
		applyOperations(
			state,
			ops.map((pair) => pair.do),
		);
		expect([...state.set]).toEqual(["b", "c"]);
	});

	it("traverses Map key/value and Set member interiors through slots", () => {
		const key = { profile: { id: 1 } };
		const value = { count: 1 };
		const member = { count: 1 };
		const state = createMutableState({ map: new TrackedMap([[key, value]]), set: new TrackedSet([member]) });

		applyOperations(state, [
			createAssignMutation(["map", "slots", 0, 0, "profile", "id"], 2),
			createAssignMutation(["map", "slots", 0, 1, "count"], 2),
			createAssignMutation(["set", "slots", 0, 0, "count"], 2),
		]);

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

		applyOperations(state, [createAssignMutation(["date", "epochMs"], 5)]);
		expect(state.date.getTime()).toBe(5);
		expect(isSameIdentity(state.date, held)).toBe(true);

		applyOperations(state, [createAssignMutation(["date"], new TrackedDate(10))]);
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

		const undo = heard[0]?.[0]?.undo;
		if (!undo) throw new Error("missing undo");
		applyOperations(state, [undo]);

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

		applyOperations(
			state,
			[...ops].reverse().map((pair) => pair.undo),
		);
		expect([...state.map]).toEqual([...before.map]);
		expect([...state.set]).toEqual([...before.set]);
		applyOperations(
			state,
			ops.map((pair) => pair.do),
		);
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
		applyOperations(
			state,
			[...ops].reverse().map((pair) => pair.undo),
			{ replay: true },
		);

		expect(state.count).toBe(0);
		expect(recorded).toHaveLength(1);
		expect(persisted).toEqual([undefined, { replay: true }]);
	});

	it("applies public diff halves exactly", () => {
		const state = createMutableState({ count: 0 });
		const ops = diffObjects({ count: 0 }, { count: 2 });

		applyOperations(
			state,
			ops.map((pair) => pair.do),
		);
		expect(state.count).toBe(2);
		applyOperations(
			state,
			[...ops].reverse().map((pair) => pair.undo),
		);
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
		applyOperations(
			state,
			[...ops].reverse().map((pair) => pair.undo),
		);

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

		applyOperations(
			state,
			ops.map((pair) => pair.do),
		);
		expect([...state.map]).toEqual([[{ id: "z" }, { label: "Z" }]]);
		applyOperations(
			state,
			[...ops].reverse().map((pair) => pair.undo),
		);
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

		applyOperations(
			state,
			[...ops].reverse().map((pair) => pair.undo),
		);

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

		applyOperations(
			state,
			ops.map((pair) => pair.do),
		);
		expect([...state.outer.get(outerKey)!]).toEqual([[{ id: "z" }, { label: "Z" }]]);
		applyOperations(
			state,
			[...ops].reverse().map((pair) => pair.undo),
		);
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

		applyOperations(
			state,
			[...ops].reverse().map((pair) => pair.undo),
		);

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

		applyOperations(
			state,
			ops.map((pair) => pair.do),
		);
		expect([...state.set].map((member) => member.id)).toEqual(["z"]);
		applyOperations(
			state,
			[...ops].reverse().map((pair) => pair.undo),
		);
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

		applyOperations(
			state,
			[...ops].reverse().map((pair) => pair.undo),
		);

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

		applyOperations(
			state,
			[...ops].reverse().map((pair) => pair.undo),
		);

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

		applyOperations(
			state,
			[...ops].reverse().map((pair) => pair.undo),
		);

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

		applyOperations(
			state,
			[...secondOps].reverse().map((pair) => pair.undo),
		);
		expect(state.root.nested.value).toBe(2);

		applyOperations(
			state,
			[...firstOps].reverse().map((pair) => pair.undo),
		);
		expect(state.root.nested.value).toBe(1);
		expect(isSameIdentity(state.root, outer)).toBe(true);
		expect(isSameIdentity(state.root.nested, inner)).toBe(true);

		applyOperations(
			state,
			firstOps.map((pair) => pair.do),
		);
		expect(state.root.nested.value).toBe(2);

		applyOperations(
			state,
			secondOps.map((pair) => pair.do),
		);
		expect(state.root.nested.value).toBe(3);
	});

	it("applies an atomic Map index address write", () => {
		const key = { id: 1 };
		const state = createMutableState({ map: new TrackedMap([[key, 1]]) });
		const addr = addressOf(key);

		applyOperations(state, [createAssignMutation(["map", "slots", 0], [key, 9] as const)]);
		expect(state.map.get(key)).toBe(9);
		applyOperations(state, [
			createDeleteMutation(["map", "index", addr]),
			createAssignMutation(["map", "slots", 0], null),
			createAssignMutation(["map", "count"], 0),
		]);
		expect(state.map.size).toBe(0);
		expect(state.map.has(key)).toBe(false);
	});
});

describe("applyOperations: resolution is the pollution defence", () => {
	it("refuses an absent own constructor exactly as it refuses an absent ordinary key", () => {
		const state = createMutableState<{ a: number }>({ a: 1 });

		// The pollution ladder itself: `constructor` then `prototype`, the shape a reserved-path
		// rule used to reject before emission. Resolution alone must now refuse it.
		expect(() =>
			applyOperations(state, [createAssignMutation(["constructor", "prototype", "polluted"], "PWNED")]),
		).toThrow("does not resolve");
		expect(() => applyOperations(state, [createDeleteMutation(["constructor", "prototype", "polluted"])])).toThrow(
			"does not resolve",
		);
		expect(() => applyOperations(state, [createAssignMutation(["constructor", "polluted"], "PWNED")])).toThrow(
			"does not resolve",
		);
		expect(() => applyOperations(state, [createAssignMutation(["zzz", "added"], 1)])).toThrow("does not resolve");

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

		applyOperations(state, ops.map((op) => op.undo).reverse());
		expect(Object.hasOwn(state.h.constructor, "prototype")).toBe(false);

		applyOperations(
			state,
			ops.map((op) => op.do),
		);
		expect(state.h.constructor.prototype).toEqual({ x: 1 });

		const withoutOwnConstructor = createMutableState<{ h: Record<string, unknown> }>({ h: {} });

		expect(() =>
			applyOperations(
				withoutOwnConstructor,
				ops.map((op) => op.do),
			),
		).toThrow("does not resolve");

		expect(Object.prototype).not.toHaveProperty("x");
		expect({}).not.toHaveProperty("x");
	});

	it("refuses a diffObjects-minted __proto__ op through the inherited-accessor guard", () => {
		const hostile = JSON.parse('{"__proto__": {"polluted": "PWNED"}}') as object;
		const ops = diffObjects({}, hostile);

		expect(ops.map((op) => op.do.path)).toEqual([["__proto__"]]);

		const state = createMutableState<{ a: number }>({ a: 1 });

		expect(() =>
			applyOperations(
				state,
				ops.map((op) => op.do),
			),
		).toThrow("inherited accessor");
		expect(Object.prototype).not.toHaveProperty("polluted");
		expect(Reflect.getPrototypeOf(state)).toBe(Object.prototype);
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

			applyOperations(state, ops.map((op) => op.undo).reverse());

			expect(state.held.a).toBe(1);
			expect(Reflect.getOwnPropertyDescriptor(state.held, "__proto__")).toEqual(before);

			applyOperations(
				state,
				ops.map((op) => op.do),
			);

			expect(state.held.a).toBe(2);
			expect(Reflect.getPrototypeOf(state.held)).toBe(Object.prototype);
			expect(Object.prototype).not.toHaveProperty("a");
		};

		roundTrip({ value: "poison", writable: false, enumerable: false, configurable: false });
		roundTrip({ value: "poison", writable: false, enumerable: false, configurable: true });
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

		applyOperations(state, recorded.map((op) => op.undo).reverse());

		expect(state.tree.child?.n).toBe(1);
		expect(state.tree.child?.deep?.m).toBe(1);
		expect(isSameIdentity(state.tree.child as object, childBefore as object)).toBe(true);

		const replayed = new Array<Operation>();

		subscribe(state, (ops) => replayed.push(...ops));

		applyOperations(state, recorded.map((op) => op.undo).reverse());

		expect(replayed).toHaveLength(0);
	});

	it("bumps no version when the slot already holds the recorded target", () => {
		const state = createMutableState<{ tree: { child?: { n: number } } }>({ tree: { child: { n: 1 } } });
		const recorded = new Array<Operation>();

		subscribe(state, (ops) => recorded.push(...ops));

		transact(state, () => {
			state.tree = {};
		});

		const undo = recorded.map((op) => op.undo).reverse();

		applyOperations(state, undo);

		const settled = getVersion(state);

		applyOperations(state, undo);

		expect(getVersion(state)).toBe(settled);
	});
});
