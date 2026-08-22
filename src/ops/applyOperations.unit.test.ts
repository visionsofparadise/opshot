import { subscribe } from "../subscribe";
import { transact } from "../transact/transact";
import { createMutableState, type Unmarked } from "../createMutableState";
import { requireHandle } from "../handle";
import { identify, isSameIdentity } from "../identity";
import { ignore, type Ignored } from "../ignore";
import { internedIdOf, nodeOfInternedId } from "../intern";
import { applyOperations } from "./applyOperations";
import {
	createAssignMutation,
	createDeleteMutation,
	createLinkMutation,
	type AssignMutation,
	type LinkMutation,
	type Mutation,
	type Operation,
} from "./operation";

const record = <T extends object>(state: T): Array<Array<Operation>> => {
	const heard = new Array<Array<Operation>>();

	subscribe(state, (ops) => heard.push([...ops]));

	return heard;
};

const internId = (state: object, node: object): number => {
	const id = internedIdOf(requireHandle(state, "opshot: applyOperations requires a state"), node);

	if (id === undefined) throw new Error("opshot: test expected an interned node");

	return id;
};

describe("applyOperations", () => {
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

	it("applies branded ops onto a distinct replica without donating live identities", () => {
		const state = createMutableState({ child: { n: 1 } });
		const heard = record(state);

		transact(state, () => {
			state.child = { n: 2 };
		});

		const replica = createMutableState({ child: { n: 1 } });

		expect(() => applyOperations(replica, heard[0] ?? [], "do")).toThrow(
			"opshot: applyOperations applies a state's operations only to that state",
		);
	});

	it("reattaches a live node both states already hold", () => {
		const shared = { n: 1 };
		const state = createMutableState<{ slot?: { n: number } }>({ slot: shared });
		const replica = createMutableState<{ slot?: { n: number } }>({});

		replica.slot = state.slot;

		const heard = record(state);

		transact(state, () => {
			delete state.slot;
		});

		expect(() => applyOperations(replica, heard[0] ?? [], "do")).toThrow(
			"opshot: applyOperations applies a state's operations only to that state",
		);
	});

	it("throws when applying another state's stamped operations", () => {
		const stateA = createMutableState({ n: 0 });
		const stateB = createMutableState({ n: 0 });
		const heard = record(stateA);

		transact(stateA, () => {
			stateA.n = 1;
		});

		expect(() => applyOperations(stateB, heard[0] ?? [], "do")).toThrow(
			"opshot: applyOperations applies a state's operations only to that state",
		);
	});

	it("applies a JSON clone of the first emission onto the same starting state", () => {
		const stateA = createMutableState({ n: 0 });
		const stateB = createMutableState({ n: 0 });
		const heard = record(stateA);

		transact(stateA, () => {
			stateA.n = 1;
		});

		applyOperations(stateB, JSON.parse(JSON.stringify(heard[0] ?? [])) as Array<Operation>, "do");

		expect(stateB.n).toBe(1);
		expect(isSameIdentity(stateB, stateA)).toBe(false);
	});

	it("throws when applying stamped operations out of order", () => {
		const state = createMutableState({ n: 0 });
		const heard = record(state);

		transact(state, () => {
			state.n = 1;
		});
		transact(state, () => {
			state.n = 2;
		});

		expect(() => applyOperations(state, heard[0] ?? [], "undo")).toThrow(
			"opshot: applyOperations applies only the next or previous operations",
		);
	});

	it("throws when applying a stamped do batch that is not the next versions", () => {
		const state = createMutableState({ n: 0 });
		const heard = record(state);

		transact(state, () => {
			state.n = 1;
		});
		transact(state, () => {
			state.n = 2;
		});

		expect(() => applyOperations(state, heard[0] ?? [], "do")).toThrow(
			"opshot: applyOperations applies only the next or previous operations",
		);
	});

	it("throws when a batch mixes this state's stamped operations with unstamped ones", () => {
		const state = createMutableState({ n: 0, extra: 0 });
		const heard = record(state);

		transact(state, () => {
			state.n = 1;
		});

		const unstamped: Operation = {
			do: createAssignMutation(["extra"], 1),
			undo: createAssignMutation(["extra"], 0),
		};

		expect(() => applyOperations(state, [...(heard[0] ?? []), unstamped], "do")).toThrow(
			"opshot: applyOperations applies a state's operations only to that state",
		);
		expect(state.n).toBe(1);
		expect(state.extra).toBe(0);
	});

	it("throws when applyOperations runs inside a transact callback", () => {
		const state = createMutableState({ n: 0 });
		const ops: Array<Operation> = [{ do: createAssignMutation(["n"], 1), undo: createAssignMutation(["n"], 0) }];

		expect(() =>
			transact(state, () => {
				applyOperations(state, ops, "do");
			}),
		).toThrow(
			"opshot: transact cannot be nested; a transaction cannot contain another. Mutate inside the callback rather than transacting, run transactions in sequence, or call applyOperations at top level.",
		);
		expect(state.n).toBe(0);
	});

	it("an organic write to a restored node emits ops addressed at its path", () => {
		const state = createMutableState<{ item?: { n: number } }>({ item: { n: 1 } });
		const heard = record(state);

		transact(state, () => {
			delete state.item;
		});

		applyOperations(state, heard[0] ?? [], "undo");
		heard.length = 0;

		transact(state, () => {
			if (state.item) state.item.n = 2;
		});

		expect(heard[0]?.map((operation) => [...operation.do.path])).toEqual([["item", "n"]]);
		expect(state.item?.n).toBe(2);
	});

	it("undo of a replace restores a frozen Map by identity", () => {
		const frozenMap = Object.freeze(new Map<string, number>([["k", 1]]));
		const state = createMutableState({
			lookup: frozenMap,
		} as unknown as { lookup: Map<string, number> | { n: number } });
		const heard = record(state);

		transact(state, () => {
			state.lookup = { n: 2 };
		});

		applyOperations(state, heard[0] ?? [], "undo");

		expect(state.lookup).toBe(frozenMap);
	});

	it("undo then redo of stamped operations restores identity", () => {
		const state = createMutableState<{ item: { n: number } }>({ item: { n: 1 } });
		const held = state.item;
		const heard = record(state);

		transact(state, () => {
			state.item = { n: 2 };
		});

		applyOperations(state, heard[0] ?? [], "undo");
		expect(isSameIdentity(state.item, held)).toBe(true);

		applyOperations(state, heard[0] ?? [], "do");
		applyOperations(state, heard[0] ?? [], "undo");
		expect(isSameIdentity(state.item, held)).toBe(true);
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

		transact(state, () => {
			state.root = { nested: { value: 3 } };
		});

		const secondOps = heard[1] ?? [];

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

describe("applyOperations: link halves", () => {
	it("resolves the root intern id to the apply write-proxy", () => {
		const state = createMutableState<{ shared: { n: number }; alias?: object }>({ shared: { n: 1 } });

		applyOperations(
			state,
			[{ do: createLinkMutation(["alias"], internId(state, state)), undo: createDeleteMutation(["alias"]) }],
			"do",
		);

		expect(state.alias).toBe(state);
	});

	it("establishes sharing on a plain target", () => {
		const state = createMutableState<{ shared: { n: number }; alias?: { n: number } }>({ shared: { n: 1 } });

		applyOperations(
			state,
			[{ do: createLinkMutation(["alias"], internId(state, state.shared)), undo: createDeleteMutation(["alias"]) }],
			"do",
		);

		expect(state.alias).toBe(state.shared);
		expect(state.alias?.n).toBe(1);
	});

	it("applies a spread or JSON-copied link half", () => {
		const state = createMutableState<{ shared: { n: number }; alias?: { n: number } }>({ shared: { n: 1 } });
		const branded = createLinkMutation(["alias"], internId(state, state.shared));
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
			{ do: createLinkMutation(["alias"], internId(state, state.shared)), undo: createDeleteMutation(["alias"]) },
		];

		applyOperations(state, ops, "do");
		expect(state.alias).toBe(state.shared);

		applyOperations(state, ops, "undo");
		expect(Object.hasOwn(state, "alias")).toBe(false);
		expect(state.shared.n).toBe(1);
	});

	it("applies a mixed values-then-links batch in do and preserves aliasing under undo", () => {
		const state = createMutableState<{
			target?: { id: number };
			other?: { id: number };
			alias?: { id: number };
		}>({});
		const ops: Array<Operation> = [
			{ do: createAssignMutation(["target"], { id: 1 }), undo: createDeleteMutation(["target"]) },
			{ do: createAssignMutation(["other"], { id: 2 }), undo: createDeleteMutation(["other"]) },
			{ do: createLinkMutation(["alias"], internId(state, state) + 1), undo: createDeleteMutation(["alias"]) },
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
			[{ do: createLinkMutation(["alias"], internId(state, state.a)), undo: createAssignMutation(["alias"], null) }],
			"do",
		);
		expect(state.alias).toBe(state.a);

		const overwrite: Operation = {
			do: createLinkMutation(["alias"], internId(state, state.b)),
			undo: createLinkMutation(["alias"], internId(state, state.a)),
		};

		applyOperations(state, [overwrite], "do");
		expect(state.alias).toBe(state.b);

		applyOperations(state, [overwrite], "undo");
		expect(state.alias).toBe(state.a);
	});

	it("refuses an unresolvable intern id", () => {
		const state = createMutableState<{ shared: { n: number } }>({ shared: { n: 1 } });

		expect(() =>
			applyOperations(
				state,
				[{ do: createLinkMutation(["alias"], 99), undo: createDeleteMutation(["alias"]) }],
				"do",
			),
		).toThrow("link at /alias with ref 99 does not resolve");
	});

	it("applies a spread assign half and a well-formed unbranded link half", () => {
		const state = createMutableState<{ shared: { n: number }; count: number; alias?: { n: number } }>({
			shared: { n: 1 },
			count: 0,
		});
		const copiedAssign = { ...createAssignMutation(["count"], 2) };
		const copiedLink = { ...createLinkMutation(["alias"], internId(state, state.shared)) };

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

	it("transported undo of a multi-alias delete restores sharing on a replica", () => {
		const shared = { n: 1 };
		const origin = createMutableState({ a: shared, b: shared });
		const heard = record(origin);

		transact(origin, () => {
			delete (origin as { a?: { n: number } }).a;
			delete (origin as { b?: { n: number } }).b;
		});

		const replicaShared = { n: 1 };
		const replica = createMutableState({ a: replicaShared, b: replicaShared });

		applyOperations(replica, JSON.parse(JSON.stringify(heard[0])) as Array<Operation>, "undo");

		expect(replica.a).toBe(replica.b);
	});

	it("an undo/redo excursion then an alias keeps sharing and numbering on a replica", () => {
		const origin = createMutableState(
			{} as {
				sh?: { n: number };
				alias?: { n: number };
			},
		);
		const heard = record(origin);

		transact(origin, () => {
			origin.sh = { n: 1 };
		});

		const windowOne = heard[0] ?? [];

		applyOperations(origin, windowOne, "undo");
		applyOperations(origin, windowOne, "do");

		heard.length = 0;

		transact(origin, () => {
			origin.alias = origin.sh;
		});

		const replica = createMutableState(
			{} as {
				sh?: { n: number };
				alias?: { n: number };
			},
		);

		applyOperations(replica, JSON.parse(JSON.stringify(windowOne)) as Array<Operation>, "do");
		applyOperations(replica, JSON.parse(JSON.stringify(windowOne)) as Array<Operation>, "undo");
		applyOperations(replica, JSON.parse(JSON.stringify(windowOne)) as Array<Operation>, "do");
		applyOperations(replica, JSON.parse(JSON.stringify(heard[0])) as Array<Operation>, "do");

		expect(replica.alias).toBe(replica.sh);
		expect(internId(origin, origin.sh!)).toBe(internId(replica, replica.sh!));
	});

	it("undo of a mixed cluster skips members still interned via another chain", () => {
		const shared = { n: 1 };
		const extra = { n: 2 };
		const origin = createMutableState({
			keep: shared,
			box: { nested: shared, extra },
		});
		const originHandle = requireHandle(origin, "opshot: test requires a state");
		const keepId = internId(origin, origin.keep);
		const boxId = internId(origin, origin.box);
		const extraId = internId(origin, origin.box.extra);
		const heard = record(origin);

		transact(origin, () => {
			delete (origin as { box?: { nested: { n: number }; extra: { n: number } } }).box;
		});

		applyOperations(origin, heard[0] ?? [], "undo");

		expect(internId(origin, origin.keep)).toBe(keepId);
		expect(internId(origin, origin.box)).toBe(boxId);
		expect(internId(origin, origin.box.extra)).toBe(extraId);
		expect(origin.box.nested).toBe(origin.keep);
		expect(nodeOfInternedId(originHandle, keepId)).toBe(origin.keep);
		expect(nodeOfInternedId(originHandle, extraId)).toBe(origin.box.extra);

		const replicaShared = { n: 1 };
		const replica = createMutableState({
			keep: replicaShared,
			box: { nested: replicaShared, extra: { n: 2 } },
		});
		const replicaHandle = requireHandle(replica, "opshot: test requires a state");
		const transported = JSON.parse(JSON.stringify(heard[0])) as Array<Operation>;

		applyOperations(replica, transported, "do");
		applyOperations(replica, transported, "undo");

		expect(replica.box.nested).toBe(replica.keep);
		expect(internId(replica, replica.keep)).toBe(keepId);
		expect(internId(replica, replica.box)).toBe(boxId);
		expect(internId(replica, replica.box.extra)).toBe(extraId);
		expect(nodeOfInternedId(replicaHandle, keepId)).toBe(replica.keep);
		expect(nodeOfInternedId(replicaHandle, extraId)).toBe(replica.box.extra);
	});

	it("bind retargets every JSON-duplicated alias slot in a departed cluster", () => {
		const shared = { n: 1 };
		const extra = { n: 2 };
		const origin = createMutableState({
			keep: shared,
			box: { a: shared, b: shared, extra },
		});
		const originHandle = requireHandle(origin, "opshot: test requires a state");
		const keepId = internId(origin, origin.keep);
		const extraId = internId(origin, origin.box.extra);
		const heard = record(origin);

		transact(origin, () => {
			delete (origin as { box?: { a: { n: number }; b: { n: number }; extra: { n: number } } }).box;
		});

		applyOperations(origin, heard[0] ?? [], "undo");

		expect(origin.box.a).toBe(origin.keep);
		expect(origin.box.b).toBe(origin.keep);
		expect(internId(origin, origin.box.extra)).toBe(extraId);
		expect(nodeOfInternedId(originHandle, extraId)).toBe(origin.box.extra);

		const replicaShared = { n: 1 };
		const replica = createMutableState({
			keep: replicaShared,
			box: { a: replicaShared, b: replicaShared, extra: { n: 2 } },
		});
		const replicaHandle = requireHandle(replica, "opshot: test requires a state");
		const transported = JSON.parse(JSON.stringify(heard[0])) as Array<Operation>;

		applyOperations(replica, transported, "do");
		applyOperations(replica, transported, "undo");

		expect(replica.box.a).toBe(replica.keep);
		expect(replica.box.b).toBe(replica.keep);
		expect(internId(replica, replica.keep)).toBe(keepId);
		expect(internId(replica, replica.box.extra)).toBe(extraId);
		expect(nodeOfInternedId(replicaHandle, extraId)).toBe(replica.box.extra);
	});

	it("undo and redo of a link window then a departure restores sharing and numbering", () => {
		const origin = createMutableState({
			keep: { n: 1 },
		} as { keep?: { n: number }; alias?: { n: number } });
		const originHandle = requireHandle(origin, "opshot: test requires a state");
		const keepId = internId(origin, origin.keep!);
		const before = originHandle.nextInternId;
		const heard = record(origin);

		transact(origin, () => {
			origin.alias = origin.keep;
		});

		expect(origin.alias).toBe(origin.keep);
		expect(internId(origin, origin.alias!)).toBe(keepId);
		expect(originHandle.nextInternId).toBe(before);

		transact(origin, () => {
			delete origin.keep;
			delete origin.alias;
		});

		expect(origin.keep).toBeUndefined();
		expect(origin.alias).toBeUndefined();

		const replica = createMutableState({
			keep: { n: 1 },
		} as { keep?: { n: number }; alias?: { n: number } });
		const replicaHandle = requireHandle(replica, "opshot: test requires a state");

		const w1 = JSON.parse(JSON.stringify(heard[0])) as Array<Operation>;
		const w2 = JSON.parse(JSON.stringify(heard[1])) as Array<Operation>;

		applyOperations(replica, w1, "do");
		expect(replica.alias).toBe(replica.keep);
		expect(internId(replica, replica.keep!)).toBe(keepId);
		expect(replicaHandle.nextInternId).toBe(before);

		applyOperations(replica, w2, "do");
		expect(replica.keep).toBeUndefined();
		expect(replica.alias).toBeUndefined();

		applyOperations(replica, w2, "undo");
		expect(replica.alias).toBe(replica.keep);
		expect(internId(replica, replica.keep!)).toBe(keepId);
		expect(replicaHandle.nextInternId).toBe(before);

		applyOperations(replica, w1, "undo");
		expect(replica.alias).toBeUndefined();
		expect(internId(replica, replica.keep!)).toBe(keepId);
		expect(replicaHandle.nextInternId).toBe(before);

		applyOperations(replica, w1, "do");
		expect(replica.alias).toBe(replica.keep);
		expect(internId(replica, replica.alias!)).toBe(keepId);

		applyOperations(replica, w2, "do");
		expect(replica.keep).toBeUndefined();
		expect(replica.alias).toBeUndefined();
	});

	it("undo of an admitting window rewinds nextInternId on origin and replica", () => {
		const origin = createMutableState({} as { extra?: { n: number } });
		const originHandle = requireHandle(origin, "opshot: test requires a state");
		const before = originHandle.nextInternId;
		const heard = record(origin);

		transact(origin, () => {
			origin.extra = { n: 1 };
		});

		expect(originHandle.nextInternId).toBeGreaterThan(before);

		applyOperations(origin, heard[0] ?? [], "undo");

		expect(originHandle.nextInternId).toBe(before);

		const replica = createMutableState({} as { extra?: { n: number } });
		const replicaHandle = requireHandle(replica, "opshot: test requires a state");

		applyOperations(replica, JSON.parse(JSON.stringify(heard[0])) as Array<Operation>, "do");
		applyOperations(replica, JSON.parse(JSON.stringify(heard[0])) as Array<Operation>, "undo");

		expect(replicaHandle.nextInternId).toBe(before);
	});

	it("transported undo of overlapping departed clusters restores the shared interior in either slot order", () => {
		interface SharedInteriorState {
			a?: { x: { s: { s: number } } };
			b?: { y: { s: { s: number }; z: { n: number } } };
		}

		const build = (sharedFirst: boolean): SharedInteriorState => {
			const shared = { s: 1 };

			return {
				a: { x: { s: shared } },
				b: { y: sharedFirst ? { s: shared, z: { n: 2 } } : { z: { n: 2 }, s: shared } },
			};
		};

		const namedNodesOf = (state: SharedInteriorState): ReadonlyArray<object> => [
			state.a!,
			state.a!.x,
			state.a!.x.s,
			state.b!,
			state.b!.y,
			state.b!.y.z,
		];

		for (const sharedFirst of [true, false]) {
			const origin = createMutableState(build(sharedFirst));
			const originHandle = requireHandle(origin, "opshot: test requires a state");
			const admitted = namedNodesOf(origin).map((node) => internId(origin, node));
			const minted = originHandle.nextInternId;
			const heard = record(origin);

			transact(origin, () => {
				delete origin.a;
				delete origin.b;
			});

			const replica = createMutableState(build(sharedFirst));
			const replicaHandle = requireHandle(replica, "opshot: test requires a state");
			const transported = JSON.parse(JSON.stringify(heard[0] ?? [])) as Array<Operation>;

			applyOperations(replica, transported, "do");

			expect(replica).toEqual(origin);
			expect(replicaHandle.nextInternId).toBe(originHandle.nextInternId);

			applyOperations(origin, heard[0] ?? [], "undo");
			applyOperations(replica, transported, "undo");

			expect(replica).toEqual(origin);
			expect(origin.a!.x.s).toBe(origin.b!.y.s);
			expect(replica.a!.x.s).toBe(replica.b!.y.s);
			expect(namedNodesOf(origin).map((node) => internId(origin, node))).toEqual(admitted);
			expect(namedNodesOf(replica).map((node) => internId(replica, node))).toEqual(admitted);
			expect(originHandle.nextInternId).toBe(minted);
			expect(replicaHandle.nextInternId).toBe(minted);
		}
	});

	it("transported undo of a cluster mutated while detached restores every member's id", () => {
		interface DetachedState {
			box?: { kid?: { k: number }; tail: { t: number } };
		}

		const build = (): DetachedState => ({ box: { kid: { k: 1 }, tail: { t: 1 } } });
		const origin = createMutableState(build());
		const originHandle = requireHandle(origin, "opshot: test requires a state");
		const admitted = [
			internId(origin, origin.box!),
			internId(origin, origin.box!.kid!),
			internId(origin, origin.box!.tail),
		];
		const minted = originHandle.nextInternId;
		const heard = record(origin);
		const held = origin.box!;

		transact(origin, () => {
			delete origin.box;
			delete held.kid;
		});

		const replica = createMutableState(build());
		const replicaHandle = requireHandle(replica, "opshot: test requires a state");
		const transported = JSON.parse(JSON.stringify(heard[0] ?? [])) as Array<Operation>;

		applyOperations(replica, transported, "do");

		expect(replica).toEqual(origin);
		expect(replicaHandle.nextInternId).toBe(originHandle.nextInternId);

		applyOperations(origin, heard[0] ?? [], "undo");
		applyOperations(replica, transported, "undo");

		expect(replica).toEqual(origin);
		expect(origin.box).toEqual({ kid: { k: 1 }, tail: { t: 1 } });
		expect([
			internId(origin, origin.box!),
			internId(origin, origin.box!.kid!),
			internId(origin, origin.box!.tail),
		]).toEqual(admitted);
		expect([
			internId(replica, replica.box!),
			internId(replica, replica.box!.kid!),
			internId(replica, replica.box!.tail),
		]).toEqual(admitted);
		expect(originHandle.nextInternId).toBe(minted);
		expect(replicaHandle.nextInternId).toBe(minted);
	});

	it("transported undo of a mixed batch restores sharing across separate departed clusters", () => {
		interface MixedBatchState {
			pair?: { p: { n: number }; q: { n: number } };
			solo?: { n: number };
		}

		const build = (): MixedBatchState => {
			const shared = { n: 1 };

			return { pair: { p: shared, q: shared }, solo: shared };
		};

		const namedNodesOf = (state: MixedBatchState): ReadonlyArray<object> => [state.pair!, state.pair!.p, state.solo!];
		const origin = createMutableState(build());
		const originHandle = requireHandle(origin, "opshot: test requires a state");
		const admitted = namedNodesOf(origin).map((node) => internId(origin, node));
		const minted = originHandle.nextInternId;
		const heard = record(origin);

		transact(origin, () => {
			delete origin.pair;
			delete origin.solo;
		});

		const replica = createMutableState(build());
		const replicaHandle = requireHandle(replica, "opshot: test requires a state");
		const transported = JSON.parse(JSON.stringify(heard[0] ?? [])) as Array<Operation>;

		applyOperations(replica, transported, "do");

		expect(replica).toEqual(origin);
		expect(replicaHandle.nextInternId).toBe(originHandle.nextInternId);

		applyOperations(origin, heard[0] ?? [], "undo");
		applyOperations(replica, transported, "undo");

		expect(replica).toEqual(origin);
		expect(origin.solo).toBe(origin.pair!.p);
		expect(origin.pair!.q).toBe(origin.pair!.p);
		expect(replica.solo).toBe(replica.pair!.p);
		expect(replica.pair!.q).toBe(replica.pair!.p);
		expect(namedNodesOf(origin).map((node) => internId(origin, node))).toEqual(admitted);
		expect(namedNodesOf(replica).map((node) => internId(replica, node))).toEqual(admitted);
		expect(originHandle.nextInternId).toBe(minted);
		expect(replicaHandle.nextInternId).toBe(minted);
	});

	it("transported undo of a cluster holding an ignored slot names only its tracked members", () => {
		interface IgnoredSlotSource {
			box?: { a: { n: number }; odd: Ignored<{ o: number }>; b: { n: number } };
		}

		const build = (): IgnoredSlotSource => ({ box: { a: { n: 1 }, odd: ignore({ o: 1 }), b: { n: 2 } } });
		const namedNodesOf = (state: Unmarked<IgnoredSlotSource>): ReadonlyArray<object> => [
			state.box!,
			state.box!.a,
			state.box!.b,
		];
		const origin = createMutableState(build());
		const originHandle = requireHandle(origin, "opshot: test requires a state");
		const admitted = namedNodesOf(origin).map((node) => internId(origin, node));
		const minted = originHandle.nextInternId;
		const heard = record(origin);

		expect(internedIdOf(originHandle, origin.box!.odd)).toBeUndefined();

		transact(origin, () => {
			delete origin.box;
		});

		const replica = createMutableState(build());
		const replicaHandle = requireHandle(replica, "opshot: test requires a state");
		const transported = JSON.parse(JSON.stringify(heard[0] ?? [])) as Array<Operation>;

		applyOperations(replica, transported, "do");

		expect(replica).toEqual(origin);
		expect(replicaHandle.nextInternId).toBe(originHandle.nextInternId);

		applyOperations(origin, heard[0] ?? [], "undo");
		applyOperations(replica, transported, "undo");

		expect(replica).toEqual(origin);
		expect(origin.box).toEqual({ a: { n: 1 }, odd: { o: 1 }, b: { n: 2 } });
		expect(namedNodesOf(origin).map((node) => internId(origin, node))).toEqual(admitted);
		expect(namedNodesOf(replica).map((node) => internId(replica, node))).toEqual(admitted);
		expect(internedIdOf(originHandle, origin.box!.odd)).toBeUndefined();
		expect(internedIdOf(replicaHandle, replica.box!.odd)).toBeUndefined();
		expect(originHandle.nextInternId).toBe(minted);
		expect(replicaHandle.nextInternId).toBe(minted);
	});

	it("a throw after an override bind leaves the batch's naming rolled back", () => {
		interface ThrownBatchState {
			keep?: { k: number };
			first?: { n: number };
			second?: { m: number };
		}

		const build = (): ThrownBatchState => ({ keep: { k: 1 }, first: { n: 1 }, second: { m: 2 } });
		const origin = createMutableState(build());
		const heard = record(origin);

		transact(origin, () => {
			delete origin.first;
			delete origin.second;
		});

		const replica = createMutableState(build());
		const replicaHandle = requireHandle(replica, "opshot: test requires a state");
		const transported = JSON.parse(JSON.stringify(heard[0] ?? [])) as Array<Operation>;

		applyOperations(replica, transported, "do");

		const unresolvable = transported[0];
		const carrier = transported[1];

		if (unresolvable === undefined || carrier === undefined) {
			throw new Error("opshot: test expected a two-operation window");
		}

		expect(carrier.undo.verb).toBe("assign");
		expect((carrier.undo as AssignMutation).ids).toBeDefined();

		const namedNodes: ReadonlyArray<object> = [replica, replica.keep!];
		const named = namedNodes.map((node) => internId(replica, node));
		const bound = replicaHandle.byId.size;
		const minted = replicaHandle.nextInternId;
		const tampered: ReadonlyArray<Operation> = [
			{ do: unresolvable.do, undo: { ...unresolvable.undo, path: ["missing", "first"] } as Mutation },
			carrier,
		];

		expect(() => {
			applyOperations(replica, tampered, "undo");
		}).toThrow("does not resolve to a supported operation address");

		expect(Object.hasOwn(replica, "first")).toBe(false);
		expect(Object.hasOwn(replica, "second")).toBe(false);
		expect(namedNodes.map((node) => internId(replica, node))).toEqual(named);
		expect(replicaHandle.byId.size).toBe(bound);
		expect(replicaHandle.nextInternId).toBe(minted);
	});
});
