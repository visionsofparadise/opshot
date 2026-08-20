import { snapshot } from "valtio/vanilla";

import { createMutableState } from "../createMutableState";
import { isSameIdentity } from "../identity";
import { ignore } from "../ignore";
import { handleOf } from "../handle";
import { OccupancyRefusalError, predatingRoutesOf } from "../occupancy";
import { subscribe } from "../subscribe";
import { TrackedDate } from "../tracked/trackedDate";
import { TrackedMap } from "../tracked/trackedMap";
import { TrackedSet } from "../tracked/trackedSet";
import { transact } from "../transact/transact";
import { applyOperations } from "./applyOperations";
import { diffObjects } from "./diff";
import {
	createAssignMutation,
	createDeleteMutation,
	createLinkMutation,
	type Mutation,
	type Operation,
} from "./operation";
import { shapeHalf, shapeOps } from "./operationShape";

const rehydrateTransportValue = (value: unknown, memo: WeakMap<object, unknown> = new WeakMap()): unknown => {
	if (value === null || (typeof value !== "object" && typeof value !== "function")) return value;

	const objectValue = value as object;
	const cached = memo.get(objectValue);

	if (cached !== undefined) return cached;

	if (Array.isArray(value)) {
		const copy: Array<unknown> = [];

		memo.set(value, copy);

		for (let index = 0; index < value.length; index++) {
			if (Object.hasOwn(value, index)) copy[index] = rehydrateTransportValue(value[index], memo);
		}

		copy.length = value.length;

		return copy;
	}

	const copy: Record<string, unknown> = {};

	memo.set(objectValue, copy);

	for (const key of Object.keys(objectValue)) {
		if (key === "__proto__") continue;

		const descriptor = Reflect.getOwnPropertyDescriptor(objectValue, key);

		if (descriptor === undefined || !("value" in descriptor)) continue;

		copy[key] = rehydrateTransportValue(descriptor.value, memo);
	}

	return copy;
};

const projectTransport = (ops: ReadonlyArray<Operation>): Array<Operation> =>
	ops.map((pair) => {
		const projectHalf = (half: Mutation): Mutation => {
			if (half.verb === "link") return createLinkMutation([...half.path], [...half.ref]);

			if (half.verb === "delete") return createDeleteMutation([...half.path]);

			return createAssignMutation([...half.path], "value" in half ? rehydrateTransportValue(half.value) : undefined);
		};

		return { do: projectHalf(pair.do), undo: projectHalf(pair.undo) };
	});

const readValue = (operation: Mutation): unknown => ("value" in operation ? operation.value : undefined);

const record = <T extends object>(state: T): Array<Array<Operation>> => {
	const heard = new Array<Array<Operation>>();

	subscribe(state, (ops) => heard.push([...ops]));

	return heard;
};

const replayUndo = <T extends object>(state: T, ops: Array<Operation>): void => applyOperations(state, ops, "undo");
const replayDo = <T extends object>(state: T, ops: Array<Operation>): void => applyOperations(state, ops, "do");

describe("diffObjects: atomic flat paths", () => {
	it("emits addition, change, and removal pairs", () => {
		const ops = diffObjects({ kept: 1, changed: 2, removed: 3 }, { kept: 1, changed: 4, added: 5 });

		expect(shapeOps(ops)).toEqual([
			{ do: { verb: "assign", path: ["changed"], value: 4 }, undo: { verb: "assign", path: ["changed"], value: 2 } },
			{ do: { verb: "delete", path: ["removed"] }, undo: { verb: "assign", path: ["removed"], value: 3 } },
			{ do: { verb: "assign", path: ["added"], value: 5 }, undo: { verb: "delete", path: ["added"] } },
		]);
	});

	it("undoes an assignment of undefined onto an absent key with a delete, not a stored undefined", () => {
		const ops = diffObjects({}, { value: undefined } as { value?: number });

		expect(ops).toHaveLength(1);
		expect(ops[0]?.do.verb).toBe("assign");
		expect(readValue(ops[0]?.do ?? { verb: "delete", path: [] })).toBeUndefined();
		expect(ops[0]?.undo.verb).toBe("delete");
	});

	it("recurses only while storage identity is continuous", () => {
		const state = createMutableState({ retained: { count: 1 }, replaced: { count: 1 } });
		const before = snapshot(state);

		transact(state, () => {
			state.retained.count = 2;
			state.replaced = { count: 2 };
		});

		const ops = diffObjects(before, snapshot(state));

		expect(ops.map((pair) => pair.do.path)).toEqual([["retained", "count"], ["replaced"]]);
		expect(readValue(ops[1]?.do ?? { verb: "delete", path: [] })).toEqual({ count: 2 });
	});

	it("emits a whole-value assign when equal content lands on a different target", () => {
		const state = createMutableState({ value: { count: 1 } });
		const heard = record(state);
		const before = state.value;

		transact(state, () => {
			state.value = { count: 1 };
		});

		expect(heard[0]).toHaveLength(1);
		expect(heard[0]?.[0]?.do).toMatchObject({ verb: "assign", path: ["value"] });
		expect(isSameIdentity(before, state.value)).toBe(false);
	});

	it("orders sparse growth length before tail additions and preserves holes", () => {
		const before = [1];
		const after = new Array<unknown>(1);

		after[0] = 1;

		after.length = 4;
		after[3] = undefined;

		const ops = diffObjects(before, after);

		expect(ops.map((pair) => shapeHalf(pair.do))).toEqual([
			{ verb: "assign", path: ["length"], value: 4 },
			{ verb: "assign", path: [3], value: undefined },
		]);
		expect(ops.map((pair) => shapeHalf(pair.undo))).toEqual([
			{ verb: "assign", path: ["length"], value: 1 },
			{ verb: "delete", path: [3] },
		]);
	});

	it("orders truncated removals before shrink and reverse undo expands first", () => {
		const before = [1, 2, 3];
		const after = [1];
		const ops = diffObjects(before, after);

		expect(ops.map((pair) => shapeHalf(pair.do))).toEqual([
			{ verb: "delete", path: [1] },
			{ verb: "delete", path: [2] },
			{ verb: "assign", path: ["length"], value: 1 },
		]);
		expect([...ops].reverse().map((pair) => shapeHalf(pair.undo))).toEqual([
			{ verb: "assign", path: ["length"], value: 3 },
			{ verb: "assign", path: [2], value: 3 },
			{ verb: "assign", path: [1], value: 2 },
		]);
	});

	it("distinguishes holes from stored undefined in overlap", () => {
		const hole = new Array<unknown>(1);
		const stored = [undefined];

		expect(diffObjects(hole, stored)[0]?.do).toEqual({ verb: "assign", path: [0], value: undefined });
		expect(diffObjects(stored, hole)[0]?.do).toEqual({ verb: "delete", path: [0] });
	});

	it("emits enumerable array non-index string properties as ordinary paths", () => {
		const before = [1];
		const after = [1];

		Object.defineProperty(before, "label", { value: "a", enumerable: true });
		Object.defineProperty(after, "label", { value: "b", enumerable: true });

		expect(shapeHalf(diffObjects(before, after)[0]!.do)).toEqual({ verb: "assign", path: ["label"], value: "b" });
	});

	it("mints nothing for a set-only accessor ↔ data transition in either direction", () => {
		const withData = { key: 1 };
		const withAccessor: Record<string, unknown> = {};

		Object.defineProperty(withAccessor, "key", {
			set: () => undefined,
			enumerable: true,
			configurable: true,
		});

		expect(diffObjects(withData, withAccessor)).toEqual([]);
		expect(diffObjects(withAccessor, withData)).toEqual([]);
	});

	it("round-trips mixed atomic changes exactly", () => {
		const key = { id: 1 };
		const state = createMutableState({
			list: [1, 2],
			map: new TrackedMap([[key, { count: 1 }]]),
			set: new TrackedSet(["a"]),
			date: new TrackedDate(0),
		});
		const heard = record(state);

		transact(state, () => {
			state.list.length = 4;
			state.list[3] = 9;
			state.map.get(key)!.count = 2;
			state.set.add("b");
			state.date.setTime(10);
		});

		const after = state;
		const ops = heard[0] ?? [];

		replayUndo(state, ops);
		expect(state.list).toEqual([1, 2]);
		expect(state.map.get(key)?.count).toBe(1);
		expect([...state.set]).toEqual(["a"]);
		expect(state.date.getTime()).toBe(0);

		replayDo(state, ops);
		expect(state).toEqual(after);
	});
});

interface Formation {
	readonly name: string;
	readonly expectedDo: {
		readonly verb: string;
		readonly path: ReadonlyArray<string | number>;
		readonly ref?: ReadonlyArray<string | number>;
	};
	readonly start: () => { readonly state: object; readonly form: () => void; readonly assertFormed: () => void };
}

const buildAliasedDiamond = (levels: number): object => {
	let node: object = { leaf: 1 };

	for (let level = 0; level < levels; level++) node = { left: node, right: node };

	return node;
};

const pathOf = (ops: ReadonlyArray<Operation> | undefined): Array<ReadonlyArray<string | number>> =>
	(ops ?? []).map((pair) => [...pair.do.path]);

describe("diffObjects: cyclic values", () => {
	const formations: ReadonlyArray<Formation> = [
		{
			name: "a child self-cycle",
			expectedDo: { verb: "link", path: ["box", "self"], ref: ["box"] },
			start: () => {
				const state = createMutableState<{ box: { n: number; self?: object } }>({ box: { n: 1 } });

				return {
					state,
					form: () => {
						state.box.self = state.box;
					},
					assertFormed: () => {
						expect(state.box.self).toBe(state.box);
					},
				};
			},
		},
		{
			name: "a wholesale cyclic object",
			expectedDo: { verb: "assign", path: ["node"] },
			start: () => {
				const state = createMutableState<{ n: number; node?: { m: number; self?: object } }>({ n: 1 });

				return {
					state,
					form: () => {
						const node: { m: number; self?: object } = { m: 1 };

						node.self = node;
						state.node = node;
					},
					assertFormed: () => {
						expect(state.node?.self).toBe(state.node);
					},
				};
			},
		},
		{
			name: "a two-node cycle",
			expectedDo: { verb: "link", path: ["a", "peer"], ref: ["b"] },
			start: () => {
				const state = createMutableState<{ a: { n: number; peer?: object }; b: { n: number; peer?: object } }>({
					a: { n: 1 },
					b: { n: 2 },
				});

				return {
					state,
					form: () => {
						state.a.peer = state.b;
						state.b.peer = state.a;
					},
					assertFormed: () => {
						expect(state.a.peer).toBe(state.b);
						expect(state.b.peer).toBe(state.a);
					},
				};
			},
		},
	];

	it("mints a self-cycle as a link with an empty ref", () => {
		const state = createMutableState<{ n: number; self?: object }>({ n: 1 });
		const heard = record(state);

		transact(state, () => {
			state.self = state;
		});

		expect(heard).toHaveLength(1);
		expect(heard[0]?.[0]?.do).toMatchObject({ verb: "link", path: ["self"], ref: [] });
		expect(state.self).toBe(state);

		const delivered = heard[0] ?? [];
		const replica = createMutableState<{ n: number; self?: object }>({ n: 1 });

		applyOperations(replica, projectTransport(delivered), "do");
		expect(replica.self).toBe(replica);

		replayUndo(state, delivered);
		expect(state.self).toBeUndefined();

		replayDo(state, delivered);
		expect(state.self).toBe(state);
	});

	it("mints a back-edge to the factory return as a link with an empty ref", () => {
		const state = createMutableState<{ child: { n: number; back?: object } }>({ child: { n: 1 } });
		const heard = record(state);

		transact(state, () => {
			state.child.back = state;
		});

		expect(heard).toHaveLength(1);
		expect(heard[0]?.[0]?.do).toMatchObject({ verb: "link", path: ["child", "back"], ref: [] });
		expect(state.child.back).toBe(state);

		const delivered = heard[0] ?? [];
		const replica = createMutableState<{ child: { n: number; back?: object } }>({ child: { n: 1 } });

		applyOperations(replica, projectTransport(delivered), "do");
		expect(replica.child.back).toBe(replica);

		replayUndo(state, delivered);
		expect(state.child.back).toBeUndefined();

		replayDo(state, delivered);
		expect(state.child.back).toBe(state);
	});

	it.each(formations.map((formation) => [formation.name, formation] as const))(
		"delivers a link or value op forming %s and round-trips undo/do",
		(_name, formation) => {
			const { state, form, assertFormed } = formation.start();
			const heard = record(state);

			transact(state, form);

			expect(heard).toHaveLength(1);
			expect(heard[0]?.[0]?.do).toMatchObject(formation.expectedDo);
			assertFormed();

			const delivered = heard[0] ?? [];

			const replicaSession = formation.start();

			applyOperations(replicaSession.state, projectTransport(delivered), "do");
			replicaSession.assertFormed();

			replayUndo(state, delivered);
			replayDo(state, delivered);
			assertFormed();
		},
	);

	it("repairs a cycle with a delete whose undo link restores the cycle by identity", () => {
		const state = createMutableState<{ box: { n: number; self?: object } }>({ box: { n: 1 } });

		state.box.self = state.box;

		transact(state, () => undefined);

		const heard = record(state);

		transact(state, () => {
			delete state.box.self;
		});

		expect(heard).toHaveLength(1);
		expect(heard[0]).toHaveLength(1);
		expect(heard[0]?.[0]?.do).toMatchObject({ verb: "delete", path: ["box", "self"] });
		expect(heard[0]?.[0]?.undo).toMatchObject({ verb: "link", path: ["box", "self"], ref: ["box"] });
		expect(state.box.self).toBeUndefined();

		const delivered = heard[0] ?? [];

		replayUndo(state, delivered);
		expect(state.box.self).toBe(state.box);

		replayDo(state, delivered);
		expect(state.box.self).toBeUndefined();
	});

	it("rolls back a throwing callback over a cyclic baseline and restores the cycle", () => {
		const state = createMutableState<{ box: { n: number; self?: object } }>({ box: { n: 1 } });

		state.box.self = state.box;

		const callbackError = new Error("callback failed");

		expect(() =>
			transact(state, () => {
				state.box.n = 99;

				throw callbackError;
			}),
		).toThrow(callbackError);
		expect(state.box.n).toBe(1);
		expect(state.box.self).toBe(state.box);
	});

	it("rolls back a throwing cycle-repairing transaction and restores the cycle", () => {
		const state = createMutableState<{ box: { n: number; self?: object } }>({ box: { n: 1 } });

		state.box.self = state.box;

		const callbackError = new Error("callback failed");

		expect(() =>
			transact(state, () => {
				delete state.box.self;

				throw callbackError;
			}),
		).toThrow(callbackError);
		expect(state.box.self).toBe(state.box);
	});

	it("rolls back a cycle formed then thrown and emits nothing", () => {
		const state = createMutableState<{ box: { n: number; self?: object } }>({ box: { n: 1 } });
		const heard = record(state);
		const callbackError = new Error("callback failed");

		expect(() =>
			transact(state, () => {
				state.box.self = state.box;

				throw callbackError;
			}),
		).toThrow(callbackError);
		expect(state.box.self).toBeUndefined();
		expect(heard).toHaveLength(0);
	});

	it("mints one op per route for a k=2 aliased interior change", () => {
		const shared = { n: 1 };
		const state = createMutableState<{ a: { b: { n: number } }; b: { n: number } }>({
			a: { b: shared },
			b: shared,
		});
		const heard = record(state);

		transact(state, () => {
			state.a.b.n = 5;
		});

		expect(pathOf(heard[0])).toEqual([
			["a", "b", "n"],
			["b", "n"],
		]);
		expect(state.a.b).toBe(state.b);
		expect(state.a.b.n).toBe(5);
	});

	it("mints a link for alias formation so a replica preserves sharing", () => {
		const shared = { n: 1 };
		const state = createMutableState<{ a: { b: { n: number } }; b: { n: number }; b2?: { n: number } }>({
			a: { b: shared },
			b: shared,
		});
		const heard = record(state);

		transact(state, () => {
			state.b2 = state.a.b;
		});

		expect(heard[0]?.[0]?.do).toMatchObject({ verb: "link", path: ["b2"], ref: ["a", "b"] });
		expect(state.b2).toBe(state.a.b);

		const replicaShared = { n: 1 };
		const replica = createMutableState<{ a: { b: { n: number } }; b: { n: number }; b2?: { n: number } }>({
			a: { b: replicaShared },
			b: replicaShared,
		});

		applyOperations(replica, projectTransport(heard[0] ?? []), "do");
		expect(replica.b2).toBe(replica.a.b);
		expect(replica.b2).toBe(replica.b);
	});

	it("mints a link undo for a delete of one route to a still-referenced node", () => {
		const shared = { n: 1 };
		const state = createMutableState<{ a: { b: { n: number } }; b?: { n: number } }>({
			a: { b: shared },
			b: shared,
		});
		const heard = record(state);

		transact(state, () => {
			delete state.b;
		});

		expect(heard[0]?.[0]?.do).toMatchObject({ verb: "delete", path: ["b"] });
		expect(heard[0]?.[0]?.undo).toMatchObject({ verb: "link", path: ["b"], ref: ["a", "b"] });
		expect(state.b).toBeUndefined();
		expect(state.a.b.n).toBe(1);

		replayUndo(state, heard[0] ?? []);
		expect(state.b).toBe(state.a.b);
	});

	it("assigns a symbol-keyed carrier with value carriage (symbol edges stay ride-along)", () => {
		const external = { marker: 1 };
		const state = createMutableState<{
			held: { marker: number };
			carrier?: { [key: symbol]: object };
		}>({ held: external });
		const symbolKey = Symbol("ride");
		const heard = record(state);

		transact(state, () => {
			const carrier: { [key: symbol]: object } = {};

			carrier[symbolKey] = state.held;
			state.carrier = carrier;
		});

		expect(heard).toHaveLength(1);
		expect(heard[0]?.[0]?.do.verb).toBe("assign");
		expect(state.carrier?.[symbolKey]).toBe(state.held);
	});

	it("accepts identity-rewiring of bisimilar self-cycles as a closed identity discontinuity", () => {
		const state = createMutableState<{ a: { self?: object } }>({ a: {} });

		state.a.self = state.a;

		transact(state, () => undefined);

		const heard = record(state);

		transact(state, () => {
			const copy: { self?: object } = {};

			copy.self = copy;
			state.a.self = copy;
		});

		expect(heard).toHaveLength(1);
		expect(heard[0]).toHaveLength(2);
		expect(heard[0]?.[0]?.do).toMatchObject({ verb: "assign", path: ["a", "self"], value: {} });
		expect(heard[0]?.[1]?.do).toMatchObject({ verb: "link", path: ["a", "self", "self"], ref: ["a", "self"] });
		expect(state.a.self).toBeDefined();
		expect((state.a.self as { self?: object }).self).toBe(state.a.self);
	});

	it("diffs a deeply aliased diamond so a replica preserves sharing", () => {
		const state = createMutableState<{ n: number; diamond?: object }>({ n: 1 });
		const heard = record(state);

		transact(state, () => {
			state.diamond = buildAliasedDiamond(64);
		});

		const replica = createMutableState<{ n: number; diamond?: object }>({ n: 1 });

		applyOperations(replica, projectTransport(heard[0] ?? []), "do");

		const root = replica.diamond as { left: object; right: object };

		expect(root.left).toBe(root.right);

		let current = root.left as { left: object; right: object };

		for (let step = 0; step < 3; step++) {
			expect(current.left).toBe(current.right);
			current = current.left as { left: object; right: object };
		}
	});

	it("restores identity on undo of a last-route delete of a cyclic node", () => {
		const state = createMutableState<{ n: number; node?: { m: number; self?: object } }>({ n: 1 });

		transact(state, () => {
			const node: { m: number; self?: object } = { m: 1 };

			node.self = node;
			state.node = node;
		});

		const held = state.node;
		const heard = record(state);

		transact(state, () => {
			delete state.node;
		});

		applyOperations(state, heard[0] ?? [], "undo");
		expect(state.node).toBe(held);
		expect(state.node?.self).toBe(state.node);
	});

	it("restores sharing on undo of a last-route delete of an aliased diamond", () => {
		const state = createMutableState<{ n: number; node?: { left: { n: number }; right: { n: number } } }>({ n: 1 });

		transact(state, () => {
			const shared = { n: 1 };

			state.node = { left: shared, right: shared };
		});

		const heard = record(state);

		transact(state, () => {
			delete state.node;
		});

		applyOperations(state, heard[0] ?? [], "undo");
		expect(state.node?.left).toBe(state.node?.right);
	});

	it("deletes two of three aliases and undoes onto the survivor", () => {
		const shared = { n: 1 };
		const state = createMutableState<{ a?: { n: number }; b?: { n: number }; c: { n: number } }>({
			a: shared,
			b: shared,
			c: shared,
		});
		const heard = record(state);

		transact(state, () => {
			delete state.a;
			delete state.b;
		});

		applyOperations(state, heard[0] ?? [], "undo");
		expect(state.a).toBe(state.b);
		expect(state.b).toBe(state.c);
	});

	it("undoes a dest overwrite and src delete onto the old dest and the shared src", () => {
		const shared = { n: 1 };
		const state = createMutableState<{ dest: { n: number }; src?: { n: number } }>({
			dest: { n: 0 },
			src: shared,
		});
		const held = state.src;
		const heard = record(state);

		transact(state, () => {
			state.dest = shared;
			delete state.src;
		});

		applyOperations(state, heard[0] ?? [], "undo");
		expect(state.dest).not.toBe(state.src);
		expect(state.dest.n).toBe(0);
		expect(state.src).toBe(held);
		expect(state.src?.n).toBe(1);
	});

	it("preserves sharing across a JSON round trip of a formation batch", () => {
		const shared = { n: 1 };
		const state = createMutableState<{ a: { n: number }; b?: { n: number } }>({ a: shared });
		const heard = record(state);

		transact(state, () => {
			state.b = state.a;
		});

		const revived = JSON.parse(JSON.stringify(heard[0] ?? [])) as Array<Operation>;
		const replica = createMutableState<{ a: { n: number }; b?: { n: number } }>({ a: { n: 1 } });

		applyOperations(replica, revived, "do");
		expect(replica.b).toBe(replica.a);
	});

	it("JSON-round-trips a JSON-serializable state's assign, delete, and cycle stream", () => {
		const state = createMutableState<{
			a: { n: number };
			b?: { n: number };
			extra?: number;
			cycle?: { self?: object };
		}>({ a: { n: 1 }, extra: 1 });
		const heard = record(state);

		transact(state, () => {
			state.b = state.a;
			delete state.extra;
			const cycle: { self?: object } = {};

			cycle.self = cycle;
			state.cycle = cycle;
		});

		const replica = createMutableState<{
			a: { n: number };
			b?: { n: number };
			extra?: number;
			cycle?: { self?: object };
		}>({ a: { n: 1 }, extra: 1 });

		applyOperations(replica, JSON.parse(JSON.stringify(heard[0] ?? [])) as Array<Operation>, "do");
		expect(replica.b).toBe(replica.a);
		expect(Object.hasOwn(replica, "extra")).toBe(false);
		expect(replica.cycle?.self).toBe(replica.cycle);
	});

	it("mints a link undo for an init-time alias overwrite", () => {
		const shared = { n: 1 };
		const state = createMutableState<{ a: { n: number }; b: { n: number }; alias: { n: number } }>({
			a: shared,
			b: { n: 2 },
			alias: shared,
		});
		const heard = record(state);

		transact(state, () => {
			state.alias = state.b;
		});

		const overwrite = heard[0] ?? [];

		expect(overwrite[0]?.do).toMatchObject({ verb: "link", path: ["alias"], ref: ["b"] });
		expect(overwrite[0]?.undo).toMatchObject({ verb: "link", path: ["alias"], ref: ["a"] });

		replayUndo(state, overwrite);
		expect(state.alias).toBe(state.a);

		replayDo(state, overwrite);
		expect(state.alias).toBe(state.b);
	});

	it("reconstructs a fresh carrier that embeds a tracked node", () => {
		const shared = { n: 1 };
		const state = createMutableState<{
			shared: { n: number };
			carrier?: { x: number; y: { n: number }; z: number };
		}>({ shared });
		const heard = record(state);

		transact(state, () => {
			state.carrier = { x: 1, y: state.shared, z: 2 };
		});

		expect(state.carrier?.y).toBe(state.shared);

		const replica = createMutableState<{
			shared: { n: number };
			carrier?: { x: number; y: { n: number }; z: number };
		}>({ shared: { n: 1 } });

		applyOperations(replica, projectTransport(heard[0] ?? []), "do");
		expect(replica.carrier?.y).toBe(replica.shared);
		expect(replica.carrier?.x).toBe(1);
		expect(replica.carrier?.z).toBe(2);
	});

	it("preserves a moved subtree's interior alias", () => {
		const shared = { n: 1 };
		const state = createMutableState<{
			shared: { n: number };
			from?: { inner: { n: number }; tag: number };
			to?: { inner: { n: number }; tag: number };
		}>({ shared, from: { inner: shared, tag: 1 } });
		const heard = record(state);

		transact(state, () => {
			state.to = state.from;
			delete state.from;
		});

		expect(state.to?.inner).toBe(state.shared);
		expect(state.from).toBeUndefined();

		const replica = createMutableState<{
			shared: { n: number };
			from?: { inner: { n: number }; tag: number };
			to?: { inner: { n: number }; tag: number };
		}>({ shared: { n: 1 }, from: { inner: { n: 1 }, tag: 1 } });

		applyOperations(replica, projectTransport(heard[0] ?? []), "do");
		expect(replica.to?.inner).toBe(replica.shared);
		expect(replica.from).toBeUndefined();
	});
});

describe("diffObjects: link batch construction", () => {
	it("carries the value at the canonical route and links the rest when both routes are new", () => {
		const state = createMutableState<{ late?: { n: number }; early?: { n: number } }>({});
		const heard = record(state);

		transact(state, () => {
			state.late = { n: 1 };
			state.early = state.late;
		});

		const delivered = heard[0] ?? [];

		expect(delivered).toHaveLength(2);
		expect(shapeOps(delivered)[0]?.do).toMatchObject({ verb: "assign", path: ["late"] });
		expect(shapeOps(delivered)[1]?.do).toEqual({ verb: "link", path: ["early"], ref: ["late"] });

		const replica = createMutableState<{ late?: { n: number }; early?: { n: number } }>({});

		applyOperations(replica, projectTransport(delivered), "do");

		expect(replica.late).toEqual({ n: 1 });
		expect(replica.early).toBe(replica.late);
	});

	it("keeps a value undo when the surviving route is torn down earlier in the undo direction", () => {
		const state = createMutableState<{ a?: { n: number }; b?: { n: number } }>({ a: { n: 1 } });
		const heard = record(state);

		transact(state, () => {
			const node = state.a;

			delete state.a;
			state.b = node;
		});

		const delivered = heard[0] ?? [];

		applyOperations(state, delivered, "undo");

		expect(state.a).toEqual({ n: 1 });
		expect(state).not.toHaveProperty("b");
	});

	it("restores the baseline when a transaction forming a move throws", () => {
		const state = createMutableState<{ from?: { deep: { n: number } }; to?: { deep: { n: number } } }>({
			from: { deep: { n: 1 } },
		});

		expect(() =>
			transact(state, () => {
				state.to = state.from;

				delete state.from;

				throw new Error("boom");
			}),
		).toThrow("boom");

		expect(state.from).toEqual({ deep: { n: 1 } });
		expect(state).not.toHaveProperty("to");
	});

	it("mints a numeric ref segment through an array index and resolves it on a replica", () => {
		const state = createMutableState<{ list: Array<{ n: number }>; slot?: { n: number } }>({ list: [{ n: 1 }] });
		const heard = record(state);

		transact(state, () => {
			state.slot = state.list[0];
		});

		const delivered = heard[0] ?? [];
		const replica = createMutableState<{ list: Array<{ n: number }>; slot?: { n: number } }>({ list: [{ n: 1 }] });

		applyOperations(replica, projectTransport(delivered), "do");

		expect(replica.slot).toBe(replica.list[0]);
	});

	it("re-mints every key of a decomposed replace, including keys the old value shared", () => {
		const state = createMutableState<{ hub: { n: number }; box: Record<string, unknown> }>({
			hub: { n: 1 },
			box: { keep: "KEEP", other: 2 },
		});
		const heard = record(state);

		transact(state, () => {
			state.box = { keep: "KEEP", inner: { alias: state.hub } };
		});

		const delivered = heard[0] ?? [];
		const replica = createMutableState<{ hub: { n: number }; box: Record<string, unknown> }>({
			hub: { n: 1 },
			box: { keep: "KEEP", other: 2 },
		});

		applyOperations(replica, projectTransport(delivered), "do");

		expect(replica.box.keep).toBe("KEEP");
		expect(replica.box).not.toHaveProperty("other");
		expect((replica.box.inner as { alias: unknown }).alias).toBe(replica.hub);
	});

	it("undo restores a surviving external route when its container occupancy is removed", () => {
		const start = (): { keep: { n: number }; bag: Record<string, unknown> } => ({
			keep: { n: 1 },
			bag: { x: 1, y: 2 },
		});

		const state = createMutableState(start());

		state.bag.slot = state.keep;

		transact(state, () => undefined);

		const heard = record(state);

		transact(state, () => {
			delete state.bag.slot;
			delete state.bag.x;
			delete state.bag.y;
		});

		const delivered = heard[0] ?? [];
		const replica = createMutableState(start());

		replica.bag.slot = replica.keep;

		const projected = projectTransport(delivered);

		applyOperations(replica, projected, "do");
		applyOperations(replica, projected, "undo");

		expect(replica.bag.slot).toBe(replica.keep);
	});

	it("undo restores a surviving external route when its container occupancy is overwritten", () => {
		const start = (): { keep: { n: number }; bag: Record<string, unknown> } => ({
			keep: { n: 1 },
			bag: { x: 1, y: 2 },
		});

		const state = createMutableState(start());

		state.bag.slot = state.keep;

		transact(state, () => undefined);

		const heard = record(state);

		transact(state, () => {
			state.bag.slot = { n: 99 };
			delete state.bag.x;
			delete state.bag.y;
		});

		const delivered = heard[0] ?? [];
		const replica = createMutableState(start());

		replica.bag.slot = replica.keep;

		const projected = projectTransport(delivered);

		applyOperations(replica, projected, "do");
		expect(replica.bag.slot).toEqual({ n: 99 });
		expect(replica.bag.slot).not.toBe(replica.keep);

		applyOperations(replica, projected, "undo");
		expect(replica.bag.slot).toBe(replica.keep);
	});

	it("carries by value a node reachable only through an ignore()d container", () => {
		const state = createMutableState({
			hold: { n: 1 } as { n: number } | undefined,
			wrapped: ignore({ held: { n: 0 } }),
			slot: undefined as { n: number } | undefined,
		});

		const node = state.hold!;

		state.wrapped = { held: node };
		delete state.hold;

		transact(state, () => undefined);

		const heard = record(state);

		transact(state, () => {
			state.slot = node;
		});

		const delivered = heard[0] ?? [];

		expect(delivered).toHaveLength(1);
		expect(delivered[0]?.do.verb).toBe("assign");

		const replica = createMutableState({
			hold: { n: 1 } as { n: number } | undefined,
			wrapped: ignore({ held: { n: 0 } }),
			slot: undefined as { n: number } | undefined,
		});

		const replicaNode = replica.hold!;

		replica.wrapped = { held: replicaNode };
		delete replica.hold;

		applyOperations(replica, projectTransport(delivered), "do");
		expect(replica.slot).toEqual({ n: 1 });
		expect(replica.slot).not.toBe(replicaNode);
	});
});

describe("diffObjects: occupancy omission", () => {
	it("a window with one refused occupancy emits sibling keys and nothing at or under the refused path", async () => {
		const errors = new Array<unknown>();
		const state = createMutableState(
			{ danger: null as unknown, sibling: 0, nested: { a: 1 } },
			{
				onError: (error) => {
					errors.push(error);
				},
			},
		);
		const heard = record(state);

		state.danger = new Map<string, number>();
		state.sibling = 1;
		state.nested.a = 2;

		await Promise.resolve();

		expect(errors[0]).toBeInstanceOf(OccupancyRefusalError);
		expect((errors[0] as OccupancyRefusalError).message).toContain("Map at /danger");
		expect(pathOf(heard[0])).toEqual([["sibling"], ["nested", "a"]]);
	});

	it("an enclosing container assign strips the refused child from its payload value", async () => {
		const errors = new Array<unknown>();
		const state = createMutableState(
			{ bag: { keep: 1 } as { keep: number; drop?: Map<string, number> }, list: [1, 2, 3] as Array<unknown> },
			{
				onError: (error) => {
					errors.push(error);
				},
			},
		);
		const heard = record(state);

		state.bag = { keep: 1, drop: new Map<string, number>() };
		state.list = [1, new Map<string, number>(), 3];

		await Promise.resolve();

		expect(errors).toHaveLength(1);

		const bagValue = readValue(
			heard[0]?.find((operation) => operation.do.path.length === 1 && operation.do.path[0] === "bag")?.do ?? {
				verb: "delete",
				path: [],
			},
		);
		const listValue = readValue(
			heard[0]?.find((operation) => operation.do.path.length === 1 && operation.do.path[0] === "list")?.do ?? {
				verb: "delete",
				path: [],
			},
		);

		expect(bagValue).toEqual({ keep: 1 });
		expect(bagValue).not.toHaveProperty("drop");
		expect(Array.isArray(listValue)).toBe(true);

		const list = listValue as Array<unknown>;

		expect(list).toHaveLength(3);
		expect(list[0]).toBe(1);
		expect(Object.hasOwn(list, 1)).toBe(false);
		expect(list[2]).toBe(3);
	});

	it("a refusal under a create-time ignore() prefix omits without minting a change pair", async () => {
		const errors = new Array<unknown>();
		const state = createMutableState(
			{ wrap: ignore({ n: 0 as number, nested: undefined as Map<string, number> | undefined }), tick: 0 },
			{
				onError: (error) => {
					errors.push(error);
				},
			},
		);
		const heard = record(state);

		state.wrap = { n: 1, nested: new Map<string, number>() };
		state.tick = 1;

		await Promise.resolve();

		expect(errors).toEqual([]);
		expect(pathOf(heard[0])).toEqual([["tick"]]);
		expect(heard[0]?.some((operation) => operation.do.path[0] === "wrap")).toBe(false);
	});
});

describe("diffObjects: decomposition and ref selection", () => {
	it("a last-route delete of a cyclic node decomposes with the re-entrant guard minting a plain removal pair", () => {
		const state = createMutableState<{ n: number; node?: { m: number; self?: object } }>({ n: 1 });

		transact(state, () => {
			const node: { m: number; self?: object } = { m: 1 };

			node.self = node;
			state.node = node;
		});

		const held = state.node;
		const heard = record(state);

		transact(state, () => {
			delete state.node;
		});

		const delivered = heard[0] ?? [];
		const selfPair = delivered.find(
			(pair) => pair.do.path.length === 2 && pair.do.path[0] === "node" && pair.do.path[1] === "self",
		);

		expect(shapeOps(delivered.filter((pair) => pair !== selfPair))).toEqual([
			{ do: { verb: "delete", path: ["node", "m"] }, undo: { verb: "assign", path: ["node", "m"], value: 1 } },
			{ do: { verb: "delete", path: ["node"] }, undo: { verb: "assign", path: ["node"], value: {} } },
		]);
		expect(selfPair?.do).toMatchObject({ verb: "delete", path: ["node", "self"] });
		expect(selfPair?.undo.verb).toBe("assign");

		replayUndo(state, delivered);
		expect(state.node).toBe(held);
		expect(state.node?.self).toBe(state.node);
	});

	it("a last-route delete of an aliased array decomposes so undo restores its sharing", () => {
		const state = createMutableState<{ n: number; node?: Array<{ n: number }> }>({ n: 1 });

		transact(state, () => {
			const shared = { n: 1 };

			state.node = [shared, shared];
		});

		const heard = record(state);

		transact(state, () => {
			delete state.node;
		});

		const delivered = heard[0] ?? [];

		expect(delivered.some((pair) => pair.do.verb === "delete" && pair.do.path[0] === "node")).toBe(true);
		expect(delivered.length).toBeGreaterThan(1);

		replayUndo(state, delivered);
		expect(state.node?.[0]).toBe(state.node?.[1]);
		expect(state.node?.[0]?.n).toBe(1);
	});

	it("replacing a self-referential container decomposes both halves", () => {
		const state = createMutableState<{ n: number; node?: { m: number; self?: object } }>({ n: 1 });

		transact(state, () => {
			const node: { m: number; self?: object } = { m: 1 };

			node.self = node;
			state.node = node;
		});

		const heard = record(state);

		transact(state, () => {
			const next: { m: number; self?: object } = { m: 2 };

			next.self = next;
			state.node = next;
		});

		const delivered = heard[0] ?? [];
		const verbs = delivered.map((pair) => pair.do.verb);
		const paths = pathOf(delivered);

		expect(delivered.length).toBeGreaterThan(2);
		expect(verbs).toContain("delete");
		expect(verbs).toContain("assign");
		expect(verbs).toContain("link");
		expect(paths.some((path) => path.length === 1 && path[0] === "node")).toBe(true);
		expect(paths.some((path) => path[0] === "node" && path[1] === "self")).toBe(true);
		expect(state.node?.self).toBe(state.node);
		expect(state.node?.m).toBe(2);

		replayUndo(state, delivered);
		expect(state.node?.m).toBe(1);
		expect(state.node?.self).toBe(state.node);
	});

	it("carries by value when the only candidate ref resolves under the container being assigned", () => {
		const state = createMutableState<{ box: { inner: { n: number }; extra?: number } }>({
			box: { inner: { n: 1 } },
		});
		const inner = state.box.inner;
		const heard = record(state);

		transact(state, () => {
			state.box = { inner, extra: 2 };
		});

		const delivered = heard[0] ?? [];

		expect(delivered.some((pair) => pair.do.verb === "link")).toBe(false);
		expect(delivered[0]?.do).toMatchObject({ verb: "assign", path: ["box"] });
		expect(state.box.inner).toBe(inner);
		expect(state.box.extra).toBe(2);
	});

	it("a second alias links to the route recorded earlier in the same batch", () => {
		const state = createMutableState<{
			first?: { n: number };
			wrapper?: { alias: { n: number } };
		}>({});
		const heard = record(state);

		transact(state, () => {
			const node = { n: 1 };

			state.first = node;
			state.wrapper = { alias: node };
		});

		const delivered = heard[0] ?? [];

		expect(shapeOps(delivered)).toEqual([
			{ do: { verb: "assign", path: ["first"], value: { n: 1 } }, undo: { verb: "delete", path: ["first"] } },
			{ do: { verb: "assign", path: ["wrapper"], value: {} }, undo: { verb: "delete", path: ["wrapper"] } },
			{
				do: { verb: "link", path: ["wrapper", "alias"], ref: ["first"] },
				undo: { verb: "delete", path: ["wrapper", "alias"] },
			},
		]);
		expect(state.wrapper?.alias).toBe(state.first);
	});

	it("route recording stops at an ignore()d edge and visits a shared descendant once", () => {
		type Shared = { n: number; self?: Shared };
		const shared: Shared = { n: 1 };

		shared.self = shared;

		const state = createMutableState({
			bag: {
				wrap: ignore({ secret: { n: 1 } }),
				left: { child: shared },
				right: { child: shared },
			},
			tick: 0,
		});
		const handle = handleOf(state);
		const heard = record(state);

		expect(handle).toBeDefined();
		expect(handle?.ignoredAt.has("/bag/wrap")).toBe(true);
		expect(predatingRoutesOf(handle!, state.bag.wrap.secret)).toEqual([]);
		expect(predatingRoutesOf(handle!, state.bag.left.child)).toEqual([
			["bag", "left", "child"],
			["bag", "left", "child", "self"],
			["bag", "right", "child"],
		]);

		transact(state, () => {
			state.tick = 1;
		});

		expect(pathOf(heard[0])).toEqual([["tick"]]);
		expect(predatingRoutesOf(handle!, state.bag.wrap.secret)).toEqual([]);
		expect(predatingRoutesOf(handle!, state.bag.wrap)).toEqual([]);
		expect(predatingRoutesOf(handle!, state.bag.left.child)).toEqual([
			["bag", "left", "child"],
			["bag", "left", "child", "self"],
			["bag", "right", "child"],
		]);
		expect(state.bag.left.child).toBe(state.bag.right.child);
		expect(state.bag.left.child.self).toBe(state.bag.left.child);
	});

	it("a decomposed sparse-array addition skips holes and restores them on undo", () => {
		const shared = { n: 1 };
		const state = createMutableState<{ keep: { n: number }; list?: Array<{ n: number } | undefined> }>({
			keep: shared,
		});
		const heard = record(state);

		transact(state, () => {
			const list = new Array<{ n: number } | undefined>(4);

			list[0] = state.keep;
			list[3] = { n: 2 };
			state.list = list;
		});

		const delivered = heard[0] ?? [];

		expect(shapeOps(delivered)).toEqual([
			{ do: { verb: "assign", path: ["list"], value: [] }, undo: { verb: "delete", path: ["list"] } },
			{
				do: { verb: "assign", path: ["list", "length"], value: 4 },
				undo: { verb: "assign", path: ["list", "length"], value: 0 },
			},
			{
				do: { verb: "link", path: ["list", 0], ref: ["keep"] },
				undo: { verb: "delete", path: ["list", 0] },
			},
			{
				do: { verb: "assign", path: ["list", 3], value: { n: 2 } },
				undo: { verb: "delete", path: ["list", 3] },
			},
		]);
		expect(state.list).toHaveLength(4);
		expect(state.list?.[0]).toBe(state.keep);
		expect(Object.hasOwn(state.list ?? {}, 1)).toBe(false);
		expect(Object.hasOwn(state.list ?? {}, 2)).toBe(false);

		replayUndo(state, delivered);
		expect(Object.hasOwn(state, "list")).toBe(false);

		replayDo(state, delivered);
		expect(state.list).toHaveLength(4);
		expect(Object.hasOwn(state.list ?? {}, 1)).toBe(false);
		expect(Object.hasOwn(state.list ?? {}, 2)).toBe(false);
		expect(state.list?.[0]).toBe(state.keep);
	});

	it("throws IncompatibleObjectRootsError for a non-plain root and a plain-object/plain-array mismatch", () => {
		const incompatible = {
			name: "IncompatibleObjectRootsError",
			message: "opshot: diffObjects requires compatible supported object roots",
		};

		expect(() => diffObjects({}, [])).toThrow(expect.objectContaining(incompatible));
		expect(() => diffObjects(new Map(), new Map())).toThrow(expect.objectContaining(incompatible));
		expect(() => diffObjects(new Date(), {})).toThrow(expect.objectContaining(incompatible));
	});
});
