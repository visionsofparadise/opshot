import { subscribe } from "../subscribe";
import { transact } from "../transact/transact";
import { createMutableState } from "../createMutableState";
import { requireHandle } from "../handle";
import { identify, isSameIdentity } from "../identity";
import { internedIdOf } from "../intern";
import { applyOperations } from "./applyOperations";
import {
	createAssignMutation,
	createDeleteMutation,
	createLinkMutation,
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
});
