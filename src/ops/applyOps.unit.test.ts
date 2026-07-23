import { createState, type Emission, type State } from "../createState";
import { identify, isSameIdentity } from "../identity";
import { addressOf } from "../tracked/address";
import { TrackedDate } from "../tracked/trackedDate";
import { TrackedMap } from "../tracked/trackedMap";
import { TrackedSet } from "../tracked/trackedSet";
import { applyOps } from "./applyOps";
import { diffSnapshots } from "./diff";
import { createAddOperation, createRemoveOperation, createReplaceOperation, type Op, type Operation } from "./operation";

const record = <T extends object>(state: State<T>): Array<Array<Op>> => {
	const heard = new Array<Array<Op>>();

	state.op.subscribe((_snapshot, ops) => heard.push(ops));

	return heard;
};

describe("applyOps: parent-sensitive atomic resolver", () => {
	it("applies mixed plain add, replace, and remove in delivery order", () => {
		const state = createState({ document: { replaced: 1, removed: 2 } as { added?: number; replaced: number; removed?: number } });

		applyOps(state, [
			createAddOperation(["document", "added"], 3),
			createReplaceOperation(["document", "replaced"], 4),
			createRemoveOperation(["document", "removed"]),
		]);

		expect(state.op.unwrap().document).toEqual({ added: 3, replaced: 4 });
	});

	it("distinguishes missing addresses from stored undefined", () => {
		const state = createState<{ document: { value?: number } }>({ document: { value: undefined } });

		applyOps(state, [createReplaceOperation(["document", "value"], 1), createReplaceOperation(["document", "value"], undefined)]);
		expect(Object.hasOwn(state.op.unwrap().document, "value")).toBe(true);
		applyOps(state, [createRemoveOperation(["document", "value"])]);
		expect(Object.hasOwn(state.op.unwrap().document, "value")).toBe(false);
		expect(() => applyOps(state, [createReplaceOperation(["document", "value"], 2)])).toThrow("does not resolve");
	});

	it("uses sparse array add/remove with no shifts", () => {
		const state = createState({ list: [1, 2, 3] });

		applyOps(state, [createRemoveOperation(["list", 1])]);
		expect(state.op.unwrap().list).toHaveLength(3);
		expect(Object.hasOwn(state.op.unwrap().list, 1)).toBe(false);
		applyOps(state, [createAddOperation(["list", 1], undefined)]);
		expect(Object.hasOwn(state.op.unwrap().list, 1)).toBe(true);
		expect(state.op.unwrap().list[2]).toBe(3);
	});

	it("applies array length and ordinary non-index string properties", () => {
		const initial = [1] as Array<number> & { label?: string };

		Object.defineProperty(initial, "label", { value: "a", enumerable: true, writable: true, configurable: true });

		const state = createState({ list: initial });

		applyOps(state, [createReplaceOperation(["list", "length"], 3), createReplaceOperation(["list", "label"], "b"), createAddOperation(["list", 2], 9)]);
		expect(state.op.unwrap().list).toHaveLength(3);
		expect(state.op.unwrap().list[2]).toBe(9);
		expect(state.op.unwrap().list.label).toBe("b");
	});

	it("rejects root, reserved, invalid verb, and invalid terminal operations before that operation mutates", () => {
		const state = createState({ count: 0, list: [1], map: new TrackedMap([["a", 1]]), set: new TrackedSet(["a"]), date: new TrackedDate(0) });

		expect(() => applyOps(state, [createReplaceOperation([], {})])).toThrow("root operations");
		expect(() => applyOps(state, [createAddOperation(["__proto__", "polluted"], true)])).toThrow("reserved operation path");
		expect(() => applyOps(state, [createRemoveOperation(["constructor", "prototype", "polluted"])])).toThrow("reserved operation path");
		expect(() => applyOps(state, [createAddOperation(["list", 0], 2)])).toThrow("does not resolve");
		expect(() => applyOps(state, [createReplaceOperation(["list", "0"], 2)])).toThrow("does not resolve");
		expect(() => applyOps(state, [createRemoveOperation(["list", "length"])])).toThrow("does not resolve");
		expect(() => applyOps(state, [createReplaceOperation(["map", "missing"], 1)])).toThrow("does not resolve");
		expect(() => applyOps(state, [createAddOperation(["date", "epochMs"], 1)])).toThrow("does not resolve");
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
			const state = createState<Record<string, number>>({});

			expect(() => applyOps(state, [createAddOperation(["opshotInheritedSetter"], 1)])).toThrow("inherited accessor");
			expect(calls).toBe(0);
		} finally {
			Reflect.deleteProperty(Object.prototype, "opshotInheritedSetter");
		}

		const locked = {} as { value: number };
		Object.defineProperty(locked, "value", { value: 1, enumerable: true, configurable: true, writable: false });
		const lockedState = createState(locked);

		expect(() => applyOps(lockedState, [createReplaceOperation(["value"], 2)])).toThrow("replay could not restore value");
	});

	it("preflights every copied half before applying any operation", () => {
		const state = createState({ count: 0 });
		const copied = { ...createReplaceOperation(["count"], 2) };

		expect(() => applyOps(state, [createReplaceOperation(["count"], 1), copied as Operation])).toThrow("this op is a copy");
		expect(state.op.unwrap().count).toBe(0);
	});

	it("rejects full Op envelopes; pass op.do or op.undo halves", () => {
		const state = createState({ count: 0 });
		const half = createReplaceOperation(["count"], 1);

		expect(() => applyOps(state, [{ do: half, undo: half } as unknown as Operation])).toThrow(
			"opshot: applyOps applies operation halves; pass op.do or op.undo.",
		);
		expect(() => applyOps(state, [{ do: half } as unknown as Operation])).toThrow(
			"opshot: applyOps applies operation halves; pass op.do or op.undo.",
		);
	});

	it("restores Map membership through plain index/slots/count ops", () => {
		const state = createState({
			map: new TrackedMap<string, number | undefined>([
				["a", 1],
				["b", 2],
			]),
		});
		const heard = record(state);

		state.mutate((mutable) => {
			mutable.map.delete("a");
			mutable.map.set("c", undefined);
		});

		const ops = heard[0] ?? [];

		applyOps(
			state,
			[...ops].reverse().map((pair) => pair.undo),
		);
		expect([...state.op.unwrap().map]).toEqual([
			["a", 1],
			["b", 2],
		]);
		applyOps(
			state,
			ops.map((pair) => pair.do),
		);
		expect([...state.op.unwrap().map]).toEqual([
			["b", 2],
			["c", undefined],
		]);
		expect(state.op.unwrap().map.has("c")).toBe(true);
	});

	it("restores Set membership through plain index/slots/count ops", () => {
		const state = createState({ set: new TrackedSet(["a", "b"]) });
		const heard = record(state);

		state.mutate((mutable) => {
			mutable.set.delete("a");
			mutable.set.add("c");
		});

		const ops = heard[0] ?? [];

		applyOps(
			state,
			[...ops].reverse().map((pair) => pair.undo),
		);
		expect([...state.op.unwrap().set]).toEqual(["a", "b"]);
		applyOps(
			state,
			ops.map((pair) => pair.do),
		);
		expect([...state.op.unwrap().set]).toEqual(["b", "c"]);
	});

	it("traverses Map key/value and Set member interiors through slots", () => {
		const key = { profile: { id: 1 } };
		const value = { count: 1 };
		const member = { count: 1 };
		const state = createState({ map: new TrackedMap([[key, value]]), set: new TrackedSet([member]) });

		applyOps(state, [
			createReplaceOperation(["map", "slots", 0, 0, "profile", "id"], 2),
			createReplaceOperation(["map", "slots", 0, 1, "count"], 2),
			createReplaceOperation(["set", "slots", 0, 0, "count"], 2),
		]);

		const storedKey = [...state.op.unwrap().map.keys()][0];
		const storedMember = [...state.op.unwrap().set][0];

		expect(storedKey?.profile.id).toBe(2);
		expect(state.op.unwrap().map.get(key)?.count).toBe(2);
		expect(storedMember?.count).toBe(2);
		expect(storedKey && isSameIdentity(storedKey, key)).toBe(true);
		expect(storedMember && isSameIdentity(storedMember, member)).toBe(true);
	});

	it("applies TrackedDate epochMs content separately from whole-target replacement", () => {
		const held = new TrackedDate(0);
		const state = createState({ date: held });

		applyOps(state, [createReplaceOperation(["date", "epochMs"], 5)]);
		expect(state.op.unwrap().date.getTime()).toBe(5);
		expect(isSameIdentity(state.op.unwrap().date, held)).toBe(true);

		// Whole-facade replace clones through the generic path (facades are clean-class cloneable).
		applyOps(state, [createReplaceOperation(["date"], new TrackedDate(10))]);
		expect(state.op.unwrap().date.getTime()).toBe(10);
		expect(state.op.unwrap().date).toBeInstanceOf(TrackedDate);
		expect(isSameIdentity(state.op.unwrap().date, held)).toBe(false);
	});

	it("restores removed targets with identity, exact content, and DAG aliases", () => {
		const shared = { count: 1 };
		const held: { kept: number; left: typeof shared; right: typeof shared; extra?: boolean } = { kept: 1, left: shared, right: shared };
		const state = createState<{ item?: typeof held }>({ item: held });
		const lookup = new Map([[identify(held), "selected"]]);
		const heard = record(state);

		state.mutate((mutable) => {
			delete mutable.item;
		});

		held.kept = 9;
		held.extra = true;
		shared.count = 9;

		const undo = heard[0]?.[0]?.undo;
		if (!undo) throw new Error("missing undo");
		applyOps(state, [undo]);

		const restored = state.op.unwrap().item;
		if (!restored) throw new Error("missing restored item");
		expect(isSameIdentity(restored, held)).toBe(true);
		expect(lookup.get(identify(restored))).toBe("selected");
		expect(restored).toEqual({ kept: 1, left: { count: 1 }, right: { count: 1 } });
		expect(restored.left).toBe(restored.right);
		expect(isSameIdentity(restored.left, shared)).toBe(true);
	});

	it("round-trips clear, delete-readd, and slot displacement atomically", () => {
		const state = createState({
			map: new TrackedMap([
				["a", 1],
				["b", 2],
			]),
			set: new TrackedSet(["a", "b"]),
		});
		const before = state.op.unwrap();
		const heard = record(state);

		state.mutate((mutable) => {
			mutable.map.clear();
			mutable.map.set("b", 20);
			mutable.map.set("a", 10);
			mutable.set.clear();
			mutable.set.add("b");
			mutable.set.add("a");
		});

		const ops = heard[0] ?? [];
		const after = state.op.unwrap();

		applyOps(
			state,
			[...ops].reverse().map((pair) => pair.undo),
		);
		expect([...state.op.unwrap().map]).toEqual([...before.map]);
		expect([...state.op.unwrap().set]).toEqual([...before.set]);
		applyOps(
			state,
			ops.map((pair) => pair.do),
		);
		expect([...state.op.unwrap().map]).toEqual([...after.map]);
		expect([...state.op.unwrap().set]).toEqual([...after.set]);
	});

	it("forwards replay meta while preserving ordered opaque history", () => {
		const state = createState({ count: 0 });
		const recorded = new Array<Array<Op>>();
		const persisted = new Array<Record<string, unknown>>();

		state.op.subscribe((_snapshot, ops, emission: Emission<{ replay?: boolean }>) => {
			if (!emission.isSideEffect && emission.meta.replay !== true) recorded.push(ops);
		});
		state.op.subscribe((_snapshot, _ops, emission: Emission<{ replay?: boolean }>) => {
			if (!emission.isSideEffect) persisted.push(emission.meta);
		});

		state.mutate((mutable) => {
			mutable.count = 1;
		});
		const ops = recorded[0];
		if (!ops) throw new Error("missing history");
		applyOps(
			state,
			[...ops].reverse().map((pair) => pair.undo),
			{ replay: true },
		);

		expect(state.op.unwrap().count).toBe(0);
		expect(recorded).toHaveLength(1);
		expect(persisted).toEqual([{}, { replay: true }]);
	});

	it("applies public diff halves exactly", () => {
		const state = createState({ count: 0 });
		const ops = diffSnapshots({ count: 0 }, { count: 2 });

		applyOps(
			state,
			ops.map((pair) => pair.do),
		);
		expect(state.op.unwrap().count).toBe(2);
		applyOps(
			state,
			[...ops].reverse().map((pair) => pair.undo),
		);
		expect(state.op.unwrap().count).toBe(0);
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
		const state = createState({ map: original });
		const selection = new Map([
			[identify(keyA), "a"],
			[identify(keyB), "b"],
		]);
		const heard = record(state);
		const beforeEntries = [...state.op.unwrap().map];

		state.mutate((mutable) => {
			mutable.map = new TrackedMap([[{ id: "z" }, { label: "Z" }]]);
		});

		const ops = heard[0] ?? [];

		expect(ops).toHaveLength(1);
		expect(ops[0]?.do).toMatchObject({ op: "replace", path: ["map"] });
		expect(isSameIdentity(state.op.unwrap().map, original)).toBe(false);

		original.delete(keyA);
		original.set(keyB, { label: "stomped-value" });
		original.set({ id: "stomp" }, { label: "stomped" });
		valueA.label = "mutated-while-detached";

		const undoHeard: Array<Array<Op>> = [];

		state.op.subscribe((_snapshot, next) => undoHeard.push(next));
		applyOps(
			state,
			[...ops].reverse().map((pair) => pair.undo),
		);

		const restored = state.op.unwrap().map;
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

		applyOps(
			state,
			ops.map((pair) => pair.do),
		);
		expect([...state.op.unwrap().map]).toEqual([[{ id: "z" }, { label: "Z" }]]);
		applyOps(
			state,
			[...ops].reverse().map((pair) => pair.undo),
		);
		expect([...state.op.unwrap().map].map(([key, value]) => [key.id, value.label])).toEqual(afterUndo);
		expect(isSameIdentity(state.op.unwrap().map, original)).toBe(true);
		expect(beforeEntries.map(([key]) => identify(key as object))).toEqual([...state.op.unwrap().map].map(([key]) => identify(key as object)));
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
		const state = createState({ outer: new TrackedMap([[outerKey, inner]]) });
		const selection = new Map([
			[identify(keyA), "a"],
			[identify(keyB), "b"],
		]);
		const heard = record(state);

		state.mutate((mutable) => {
			mutable.outer.set(outerKey, new TrackedMap([[{ id: "z" }, { label: "Z" }]]));
		});

		const ops = heard[0] ?? [];

		expect(ops.length).toBeGreaterThan(0);

		inner.delete(keyA);
		inner.set(keyB, { label: "stomped-value" });
		inner.set({ id: "stomp" }, { label: "stomped" });
		valueA.label = "mutated-while-detached";

		applyOps(
			state,
			[...ops].reverse().map((pair) => pair.undo),
		);

		const restored = state.op.unwrap().outer.get(outerKey);

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

		applyOps(
			state,
			ops.map((pair) => pair.do),
		);
		expect([...state.op.unwrap().outer.get(outerKey)!]).toEqual([[{ id: "z" }, { label: "Z" }]]);
		applyOps(
			state,
			[...ops].reverse().map((pair) => pair.undo),
		);
		expect([...state.op.unwrap().outer.get(outerKey)!].map(([key, value]) => [key.id, value.label])).toEqual([
			["a", "A"],
			["b", "B"],
		]);
		expect(isSameIdentity(state.op.unwrap().outer.get(outerKey)!, inner)).toBe(true);
	});

	it("restores a whole TrackedSet replace under a plain parent", () => {
		const memberA = { id: "a" };
		const memberB = { id: "b" };
		const original = new TrackedSet([memberA, memberB]);
		const state = createState({ set: original });
		const selection = new Map([
			[identify(memberA), "a"],
			[identify(memberB), "b"],
		]);
		const heard = record(state);

		state.mutate((mutable) => {
			mutable.set = new TrackedSet([{ id: "z" }]);
		});

		const ops = heard[0] ?? [];

		expect(ops).toHaveLength(1);
		expect(ops[0]?.do).toMatchObject({ op: "replace", path: ["set"] });

		original.delete(memberA);
		original.add({ id: "stomp" });
		memberA.id = "mutated-while-detached";

		applyOps(
			state,
			[...ops].reverse().map((pair) => pair.undo),
		);

		const restored = state.op.unwrap().set;
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

		applyOps(
			state,
			ops.map((pair) => pair.do),
		);
		expect([...state.op.unwrap().set].map((member) => member.id)).toEqual(["z"]);
		applyOps(
			state,
			[...ops].reverse().map((pair) => pair.undo),
		);
		expect([...state.op.unwrap().set].map((member) => member.id)).toEqual(["a", "b"]);
		expect(isSameIdentity(state.op.unwrap().set, original)).toBe(true);
	});

	it("keeps identify()-keyed consumers alive across a whole plain-container replace", () => {
		const itemA = { id: "a" };
		const itemB = { id: "b" };
		const container = { items: [itemA, itemB] };
		const state = createState({ document: container });
		const selection = new Map([
			[identify(itemA), "selected-a"],
			[identify(itemB), "selected-b"],
		]);
		const heard = record(state);

		state.mutate((mutable) => {
			mutable.document = { items: [{ id: "z" }] };
		});

		const ops = heard[0] ?? [];

		expect(ops).toHaveLength(1);
		expect(ops[0]?.do).toMatchObject({ op: "replace", path: ["document"] });

		applyOps(
			state,
			[...ops].reverse().map((pair) => pair.undo),
		);

		const restored = state.op.unwrap().document;

		expect(selection.get(identify(restored.items[0]!))).toBe("selected-a");
		expect(selection.get(identify(restored.items[1]!))).toBe("selected-b");
		expect(isSameIdentity(restored.items[0]!, itemA)).toBe(true);
		expect(isSameIdentity(restored.items[1]!, itemB)).toBe(true);
	});

	it("restores DAG aliases inside whole-container replace contents to shared storage", () => {
		const shared = { count: 1 };
		const container = { left: shared, right: shared };
		const state = createState({ document: container });
		const heard = record(state);

		state.mutate((mutable) => {
			mutable.document = { left: { count: 9 }, right: { count: 9 } };
		});

		const ops = heard[0] ?? [];

		applyOps(
			state,
			[...ops].reverse().map((pair) => pair.undo),
		);

		const restored = state.op.unwrap().document;

		expect(isSameIdentity(restored.left, restored.right)).toBe(true);
		expect(isSameIdentity(restored.left, shared)).toBe(true);
		expect(restored.left.count).toBe(1);
		expect(restored.right.count).toBe(1);
	});

	it("retains the pre-mutation container target after undoing a whole-container replace", () => {
		const container = { count: 1 };
		const state = createState({ document: container });
		const heard = record(state);

		state.mutate((mutable) => {
			mutable.document = { count: 2 };
		});

		const ops = heard[0] ?? [];

		expect(isSameIdentity(state.op.unwrap().document, container)).toBe(false);

		applyOps(
			state,
			[...ops].reverse().map((pair) => pair.undo),
		);

		expect(isSameIdentity(state.op.unwrap().document, container)).toBe(true);
		expect(state.op.unwrap().document.count).toBe(1);
	});

	it("round-trips a whole-container replace nested under another whole-container replace", () => {
		const inner = { value: 1 };
		const outer = { nested: inner };
		const state = createState({ root: outer });
		const heard = record(state);

		state.mutate((mutable) => {
			mutable.root = { nested: { value: 2 } };
		});

		const firstOps = heard[0] ?? [];

		expect(firstOps).toHaveLength(1);
		expect(firstOps[0]?.do).toMatchObject({ op: "replace", path: ["root"] });

		state.mutate((mutable) => {
			mutable.root = { nested: { value: 3 } };
		});

		const secondOps = heard[1] ?? [];

		expect(secondOps).toHaveLength(1);
		expect(secondOps[0]?.do).toMatchObject({ op: "replace", path: ["root"] });

		applyOps(
			state,
			[...secondOps].reverse().map((pair) => pair.undo),
		);
		expect(state.op.unwrap().root.nested.value).toBe(2);

		applyOps(
			state,
			[...firstOps].reverse().map((pair) => pair.undo),
		);
		expect(state.op.unwrap().root.nested.value).toBe(1);
		expect(isSameIdentity(state.op.unwrap().root, outer)).toBe(true);
		expect(isSameIdentity(state.op.unwrap().root.nested, inner)).toBe(true);

		applyOps(
			state,
			firstOps.map((pair) => pair.do),
		);
		expect(state.op.unwrap().root.nested.value).toBe(2);

		applyOps(
			state,
			secondOps.map((pair) => pair.do),
		);
		expect(state.op.unwrap().root.nested.value).toBe(3);
	});

	it("applies an atomic Map index address write", () => {
		const key = { id: 1 };
		const state = createState({ map: new TrackedMap([[key, 1]]) });
		const addr = addressOf(key);

		applyOps(state, [createReplaceOperation(["map", "slots", 0], [key, 9] as const)]);
		expect(state.op.unwrap().map.get(key)).toBe(9);
		applyOps(state, [createRemoveOperation(["map", "index", addr]), createReplaceOperation(["map", "slots", 0], null), createReplaceOperation(["map", "count"], 0)]);
		expect(state.op.unwrap().map.size).toBe(0);
		expect(state.op.unwrap().map.has(key)).toBe(false);
	});
});
