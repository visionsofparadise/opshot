import { snapshot, unstable_getInternalStates } from "valtio/vanilla";

import { createMutableState } from "../createMutableState";
import { internedOccupied } from "./internedOccupancy";
import { handleOf, requireHandle } from "../handle";
import { isSameIdentity } from "../identity";
import { ignore, isIgnored } from "../ignore";
import { internedIdOf } from "../intern";
import { walkDataEntries } from "../utils/dataEntries";
import { subscribe } from "../subscribe";
import { TrackedDate } from "../tracked/trackedDate";
import { TrackedMap } from "../tracked/trackedMap";
import { TrackedSet } from "../tracked/trackedSet";
import { unsafeTrack } from "../unsafeTrack";
import { batch } from "../batch";
import { applyOperations } from "./applyOperations";
import { diffObjects } from "./diff";
import {
	createAssignMutation,
	createDeleteMutation,
	createLinkMutation,
	type AssignMutation,
	type Mutation,
	type Operation,
} from "./operation";
import { shapeHalf, shapeOps } from "./operationShape";

const { proxyStateMap } = unstable_getInternalStates();

const rawTargetOf = (value: object): object => proxyStateMap.get(value)?.[0] ?? value;

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

		if (Object.isFrozen(value)) Object.freeze(copy);

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

	if (Object.isFrozen(objectValue)) Object.freeze(copy);

	return copy;
};

const projectTransport = (ops: ReadonlyArray<Operation>): Array<Operation> =>
	ops.map((pair) => {
		const projectHalf = (half: Mutation): Mutation => {
			if (half.verb === "link") return createLinkMutation([...half.path], half.ref);

			if (half.verb === "delete") return createDeleteMutation([...half.path]);

			return createAssignMutation([...half.path], rehydrateTransportValue(half.value), undefined, half.ids);
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

const internId = (state: object, node: object): number => {
	const id = internedIdOf(requireHandle(state, "opshot: test requires a state"), node);

	if (id === undefined) throw new Error("opshot: test expected an interned node");

	return id;
};

const internSequenceOf = (root: object): Array<number> => {
	const handle = requireHandle(root, "opshot: test requires a state");
	const seen = new Set<number>();
	const ids = new Array<number>();

	const walk = (node: object): void => {
		const id = internedIdOf(handle, node);

		if (id === undefined || seen.has(id)) return;

		seen.add(id);
		ids.push(id);

		for (const entry of walkDataEntries(node)) {
			if (typeof entry.value === "object" && entry.value !== null) walk(entry.value);
		}
	};

	walk(root);

	return ids;
};

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

		batch(() => {
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

		batch(() => {
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

		batch(() => {
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
	readonly expectedDo: (state: object) => {
		readonly verb: string;
		readonly path: ReadonlyArray<string | number>;
		readonly ref?: number;
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
			expectedDo: (state) => ({
				verb: "link",
				path: ["box", "self"],
				ref: internId(state, (state as { box: object }).box),
			}),
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
			expectedDo: () => ({ verb: "assign", path: ["node"] }),
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
			expectedDo: (state) => ({
				verb: "link",
				path: ["a", "peer"],
				ref: internId(state, (state as { b: object }).b),
			}),
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

	it("mints a self-cycle as a link with the root intern id", () => {
		const state = createMutableState<{ n: number; self?: object }>({ n: 1 });
		const heard = record(state);

		batch(() => {
			state.self = state;
		});

		expect(heard).toHaveLength(1);
		expect(heard[0]?.[0]?.do).toMatchObject({ verb: "link", path: ["self"], ref: internId(state, state) });
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

	it("mints a back-edge to the factory return as a link with the root intern id", () => {
		const state = createMutableState<{ child: { n: number; back?: object } }>({ child: { n: 1 } });
		const heard = record(state);

		batch(() => {
			state.child.back = state;
		});

		expect(heard).toHaveLength(1);
		expect(heard[0]?.[0]?.do).toMatchObject({ verb: "link", path: ["child", "back"], ref: internId(state, state) });
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

			batch(form);

			expect(heard).toHaveLength(1);
			expect(heard[0]?.[0]?.do).toMatchObject(formation.expectedDo(state));
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

	it("repairs a cycle with a delete whose undo link restores the cycle by identity", async () => {
		const state = createMutableState<{ box: { n: number; self?: object } }>({ box: { n: 1 } });

		state.box.self = state.box;

		await Promise.resolve();

		const heard = record(state);

		batch(() => {
			delete state.box.self;
		});

		expect(heard).toHaveLength(1);
		expect(heard[0]).toHaveLength(1);
		expect(heard[0]?.[0]?.do).toMatchObject({ verb: "delete", path: ["box", "self"] });
		expect(heard[0]?.[0]?.undo).toMatchObject({
			verb: "link",
			path: ["box", "self"],
			ref: internId(state, state.box),
		});
		expect(state.box.self).toBeUndefined();

		const delivered = heard[0] ?? [];

		replayUndo(state, delivered);
		expect(state.box.self).toBe(state.box);

		replayDo(state, delivered);
		expect(state.box.self).toBeUndefined();
	});

	it("keeps completed writes when a throwing callback mutates a cyclic baseline", () => {
		const state = createMutableState<{ box: { n: number; self?: object } }>({ box: { n: 1 } });

		state.box.self = state.box;

		const callbackError = new Error("callback failed");

		expect(() =>
			batch(() => {
				state.box.n = 99;

				throw callbackError;
			}),
		).toThrow(callbackError);
		expect(state.box.n).toBe(99);
		expect(state.box.self).toBe(state.box);
	});

	it("keeps a cycle deletion when the callback throws", () => {
		const state = createMutableState<{ box: { n: number; self?: object } }>({ box: { n: 1 } });

		state.box.self = state.box;

		const callbackError = new Error("callback failed");

		expect(() =>
			batch(() => {
				delete state.box.self;

				throw callbackError;
			}),
		).toThrow(callbackError);
		expect(state.box.self).toBeUndefined();
	});

	it("emits a cycle formed then thrown", () => {
		const state = createMutableState<{ box: { n: number; self?: object } }>({ box: { n: 1 } });
		const heard = record(state);
		const callbackError = new Error("callback failed");

		expect(() =>
			batch(() => {
				state.box.self = state.box;

				throw callbackError;
			}),
		).toThrow(callbackError);
		expect(state.box.self).toBe(state.box);
		expect(heard).toHaveLength(1);
	});

	it("mints one op per route for a k=2 aliased interior change", () => {
		const shared = { n: 1 };
		const state = createMutableState<{ a: { b: { n: number } }; b: { n: number } }>({
			a: { b: shared },
			b: shared,
		});
		const heard = record(state);

		batch(() => {
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

		batch(() => {
			state.b2 = state.a.b;
		});

		expect(heard[0]?.[0]?.do).toMatchObject({ verb: "link", path: ["b2"], ref: internId(state, state.a.b) });
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

		batch(() => {
			delete state.b;
		});

		expect(heard[0]?.[0]?.do).toMatchObject({ verb: "delete", path: ["b"] });
		expect(heard[0]?.[0]?.undo).toMatchObject({ verb: "link", path: ["b"], ref: internId(state, state.a.b) });
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

		batch(() => {
			const carrier: { [key: symbol]: object } = {};

			carrier[symbolKey] = state.held;
			state.carrier = carrier;
		});

		expect(heard).toHaveLength(1);
		expect(heard[0]?.[0]?.do.verb).toBe("assign");
		expect(state.carrier?.[symbolKey]).toBe(state.held);
	});

	it("accepts identity-rewiring of bisimilar self-cycles as a closed identity discontinuity", async () => {
		const state = createMutableState<{ a: { self?: object } }>({ a: {} });

		state.a.self = state.a;

		await Promise.resolve();

		const heard = record(state);

		batch(() => {
			const copy: { self?: object } = {};

			copy.self = copy;
			state.a.self = copy;
		});

		expect(heard).toHaveLength(1);
		expect(heard[0]).toHaveLength(2);
		expect(heard[0]?.[0]?.do).toMatchObject({ verb: "assign", path: ["a", "self"], value: {} });
		expect(heard[0]?.[1]?.do).toMatchObject({
			verb: "link",
			path: ["a", "self", "self"],
			ref: internId(state, state.a.self as object),
		});
		expect(state.a.self).toBeDefined();
		expect((state.a.self as { self?: object }).self).toBe(state.a.self);
	});

	it("diffs a deeply aliased diamond so a replica preserves sharing", () => {
		const state = createMutableState<{ n: number; diamond?: object }>({ n: 1 });
		const heard = record(state);

		batch(() => {
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

		batch(() => {
			const node: { m: number; self?: object } = { m: 1 };

			node.self = node;
			state.node = node;
		});

		const held = state.node;
		const heard = record(state);

		batch(() => {
			delete state.node;
		});

		applyOperations(state, heard[0] ?? [], "undo");
		expect(state.node).toBe(held);
		expect(state.node?.self).toBe(state.node);
	});

	it("restores sharing on undo of a last-route delete of an aliased diamond", () => {
		const state = createMutableState<{ n: number; node?: { left: { n: number }; right: { n: number } } }>({ n: 1 });

		batch(() => {
			const shared = { n: 1 };

			state.node = { left: shared, right: shared };
		});

		const heard = record(state);

		batch(() => {
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

		batch(() => {
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

		batch(() => {
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

		batch(() => {
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

		batch(() => {
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

		batch(() => {
			state.alias = state.b;
		});

		const overwrite = heard[0] ?? [];

		expect(overwrite[0]?.do).toMatchObject({ verb: "link", path: ["alias"], ref: internId(state, state.b) });
		expect(overwrite[0]?.undo).toMatchObject({ verb: "link", path: ["alias"], ref: internId(state, state.a) });

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

		batch(() => {
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

		batch(() => {
			state.to = state.from;
			delete state.from;
		});

		expect(state.to?.inner).toBe(state.shared);
		expect(state.from).toBeUndefined();

		const replicaShared = { n: 1 };
		const replica = createMutableState<{
			shared: { n: number };
			from?: { inner: { n: number }; tag: number };
			to?: { inner: { n: number }; tag: number };
		}>({ shared: replicaShared, from: { inner: replicaShared, tag: 1 } });

		applyOperations(replica, projectTransport(heard[0] ?? []), "do");
		expect(replica.to?.inner).toBe(replica.shared);
		expect(replica.from).toBeUndefined();
	});
});

describe("diffObjects: link batch construction", () => {
	it("carries the value at the first occupancy and links the rest when both occupancies are new", () => {
		const state = createMutableState<{ late?: { n: number }; early?: { n: number } }>({});
		const heard = record(state);

		batch(() => {
			state.late = { n: 1 };
			state.early = state.late;
		});

		const delivered = heard[0] ?? [];

		expect(delivered).toHaveLength(2);
		expect(shapeOps(delivered)[0]?.do).toMatchObject({ verb: "assign", path: ["late"] });
		expect(shapeOps(delivered)[1]?.do).toEqual({ verb: "link", path: ["early"], ref: internId(state, state.late!) });

		const replica = createMutableState<{ late?: { n: number }; early?: { n: number } }>({});

		applyOperations(replica, projectTransport(delivered), "do");

		expect(replica.late).toEqual({ n: 1 });
		expect(replica.early).toBe(replica.late);
	});

	it("keeps a value undo when the surviving route is torn down earlier in the undo direction", () => {
		const state = createMutableState<{ a?: { n: number }; b?: { n: number } }>({ a: { n: 1 } });
		const heard = record(state);

		batch(() => {
			const node = state.a;

			delete state.a;
			state.b = node;
		});

		const delivered = heard[0] ?? [];

		applyOperations(state, delivered, "undo");

		expect(state.a).toEqual({ n: 1 });
		expect(state).not.toHaveProperty("b");
	});

	it("keeps a move when the callback throws", () => {
		const state = createMutableState<{ from?: { deep: { n: number } }; to?: { deep: { n: number } } }>({
			from: { deep: { n: 1 } },
		});

		expect(() =>
			batch(() => {
				state.to = state.from;

				delete state.from;

				throw new Error("boom");
			}),
		).toThrow("boom");

		expect(state.to).toEqual({ deep: { n: 1 } });
		expect(state).not.toHaveProperty("from");
	});

	it("mints a numeric ref segment through an array index and resolves it on a replica", () => {
		const state = createMutableState<{ list: Array<{ n: number }>; slot?: { n: number } }>({ list: [{ n: 1 }] });
		const heard = record(state);

		batch(() => {
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

		batch(() => {
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

	it("undo restores a surviving external route when its container occupancy is removed", async () => {
		const start = (): { keep: { n: number }; bag: Record<string, unknown> } => ({
			keep: { n: 1 },
			bag: { x: 1, y: 2 },
		});

		const state = createMutableState(start());

		state.bag.slot = state.keep;

		await Promise.resolve();

		const heard = record(state);

		batch(() => {
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

	it("undo restores a surviving external route when its container occupancy is overwritten", async () => {
		const start = (): { keep: { n: number }; bag: Record<string, unknown> } => ({
			keep: { n: 1 },
			bag: { x: 1, y: 2 },
		});

		const state = createMutableState(start());

		state.bag.slot = state.keep;

		await Promise.resolve();

		const heard = record(state);

		batch(() => {
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

	it("links a node that stayed occupied through an identity-marked replacement of a previously ignored wrapper", async () => {
		const origin = createMutableState({
			hold: { n: 1 } as { n: number } | undefined,
			wrapped: ignore({ held: { n: 0 } }),
			slot: undefined as { n: number } | undefined,
		});
		const node = origin.hold!;
		const heard = record(origin);

		origin.wrapped = { held: node };
		delete origin.hold;

		await Promise.resolve();

		batch(() => {
			origin.slot = node;
		});

		expect(heard[1]?.[0]?.do.verb).toBe("link");
		expect(heard[1]?.[0]?.do.path).toEqual(["slot"]);

		const replica = createMutableState({
			hold: { n: 1 } as { n: number } | undefined,
			wrapped: ignore({ held: { n: 0 } }),
			slot: undefined as { n: number } | undefined,
		});

		applyOperations(replica, projectTransport(heard[0] ?? []), "do");
		applyOperations(replica, projectTransport(heard[1] ?? []), "do");

		expect(replica.slot).toEqual({ n: 1 });
		expect(Object.hasOwn(replica, "hold")).toBe(false);
	});

	it("evicts interiors of a departed cluster", () => {
		const state = createMutableState({ box: { inner: { n: 1 } } });
		const handle = requireHandle(state, "opshot: test requires a state");
		const inner = state.box.inner;
		const innerId = internedIdOf(handle, inner);

		expect(innerId).toBeDefined();

		batch(() => {
			delete (state as { box?: { inner: { n: number } } }).box;
		});

		expect(internedOccupied(handle, inner)).toBe(false);
		expect(handle.byId.has(innerId!)).toBe(false);
		expect(internedIdOf(handle, inner)).toBe(innerId);
		expect(internedIdOf(handle, state)).toBe(0);
	});

	it("keeps the intern id of a departed cluster member still occupied via another chain", () => {
		const shared = { n: 1 };
		const state = createMutableState({ keep: shared, box: { nested: shared } });
		const handle = requireHandle(state, "opshot: test requires a state");
		const box = state.box;
		const id = internedIdOf(handle, shared);

		expect(id).toBeDefined();

		batch(() => {
			delete (state as { box?: { nested: { n: number } } }).box;
		});

		expect(internedOccupied(handle, box)).toBe(false);
		expect(internedIdOf(handle, shared)).toBe(id);
	});

	it("evicts nothing when a node departs and returns in the same window", () => {
		const state = createMutableState({ box: { n: 1 } });
		const handle = requireHandle(state, "opshot: test requires a state");
		const box = state.box;

		batch(() => {
			delete (state as { box?: { n: number } }).box;
			state.box = box;
		});

		expect(internedOccupied(handle, box)).toBe(true);
		expect(internedIdOf(handle, box)).toBeDefined();
	});

	it("replays a user-held node mutated while detached with current content on a replica", () => {
		const origin = createMutableState({ box: { n: 1 } as { n: number } | undefined });
		const node = origin.box!;
		const heard = record(origin);

		batch(() => {
			delete origin.box;
		});

		node.n = 99;

		batch(() => {
			origin.box = node;
		});

		expect(heard[1]?.[0]?.do).toMatchObject({ verb: "assign", path: ["box"], value: { n: 99 } });

		const replica = createMutableState({ box: { n: 1 } as { n: number } | undefined });

		applyOperations(replica, projectTransport(heard[0] ?? []), "do");
		applyOperations(replica, projectTransport(heard[1] ?? []), "do");

		expect(replica.box).toEqual({ n: 99 });
	});

	it("evicts a cluster whose interior edge points back at its own entry", () => {
		const origin = createMutableState<{ a?: { x: { n: number; back?: object } } }>({ a: { x: { n: 1 } } });
		const handle = requireHandle(origin, "opshot: test requires a state");
		const held = origin.a!;
		const inner = held.x;
		const heard = record(origin);

		batch(() => {
			inner.back = held;
		});

		batch(() => {
			delete origin.a;
		});

		expect(internedOccupied(handle, held)).toBe(true);
		expect(internedOccupied(handle, inner)).toBe(true);
		expect(handle.byId.has(internedIdOf(handle, held)!)).toBe(true);
		expect(handle.byId.has(internedIdOf(handle, inner)!)).toBe(true);

		held.x.n = 99;

		batch(() => {
			origin.a = held;
		});

		expect(origin.a?.x.back).toBe(origin.a);

		const replica = createMutableState<{ a?: { x: { n: number; back?: object } } }>({ a: { x: { n: 1 } } });
		const replicaHandle = requireHandle(replica, "opshot: test requires a state");

		for (const window of heard) applyOperations(replica, projectTransport(window), "do");

		expect(replica.a?.x.back).toBe(replica.a);
		expect(replicaHandle.nextInternId).toBe(handle.nextInternId);
	});

	it("evicts a cluster whose entry points back at itself", () => {
		const state = createMutableState<{ cyc?: { n: number; self?: object } }>({ cyc: { n: 1 } });
		const handle = requireHandle(state, "opshot: test requires a state");
		const node = state.cyc!;

		batch(() => {
			node.self = node;
		});

		batch(() => {
			delete state.cyc;
		});

		expect(internedOccupied(handle, node)).toBe(true);
		expect(internedIdOf(handle, state)).toBe(0);
		expect(handle.byId.has(internedIdOf(handle, node)!)).toBe(true);
	});
});

describe("diffObjects: occupancy classification", () => {
	it("a container carrying a refused child refuses whole at the statement", () => {
		const state = createMutableState<{ bag: unknown; list: Array<unknown> }>({
			bag: { keep: 1 },
			list: [1, 2, 3],
		});
		const heard = record(state);
		const bag = state.bag;
		const list = state.list.slice();

		expect(() => {
			state.bag = { keep: 1, drop: new Map<string, number>() };
		}).toThrow("Map at /bag/drop cannot be tracked");
		expect(() => {
			state.list = [1, new Map<string, number>(), 3];
		}).toThrow("Map at /list/1 cannot be tracked");

		expect(state.bag).toBe(bag);
		expect(state.list).toEqual(list);
		expect(heard).toEqual([]);
	});

	it("an ignored prefix omits without minting a change pair", async () => {
		const state = createMutableState({
			wrap: ignore({ n: 0 as number, nested: undefined as Map<string, number> | undefined }),
			tick: 0,
		});
		const heard = record(state);

		state.wrap = ignore({ n: 1, nested: new Map<string, number>() });
		state.tick = 1;

		await Promise.resolve();

		expect(pathOf(heard[0])).toEqual([["tick"]]);
		expect(heard[0]?.some((operation) => operation.do.path[0] === "wrap")).toBe(false);
	});
});

describe("diffObjects: decomposition and ref selection", () => {
	it("a last-route delete of a cyclic node carries the value and restores the cycle on undo", () => {
		const state = createMutableState<{ n: number; node?: { m: number; self?: object } }>({ n: 1 });

		batch(() => {
			const node: { m: number; self?: object } = { m: 1 };

			node.self = node;
			state.node = node;
		});

		const held = state.node;
		const heard = record(state);

		batch(() => {
			delete state.node;
		});

		const delivered = heard[0] ?? [];

		expect(delivered).toHaveLength(1);
		expect(delivered[0]?.do).toMatchObject({ verb: "delete", path: ["node"] });
		expect(delivered[0]?.undo.verb).toBe("link");

		replayUndo(state, delivered);
		expect(state.node).toBe(held);
		expect(state.node?.self).toBe(state.node);
	});

	it("a last-route delete of an aliased array carries the value so undo restores its sharing", () => {
		const state = createMutableState<{ n: number; node?: Array<{ n: number }> }>({ n: 1 });

		batch(() => {
			const shared = { n: 1 };

			state.node = [shared, shared];
		});

		const heard = record(state);

		batch(() => {
			delete state.node;
		});

		const delivered = heard[0] ?? [];

		expect(delivered).toHaveLength(1);
		expect(delivered[0]?.do).toMatchObject({ verb: "delete", path: ["node"] });

		replayUndo(state, delivered);
		expect(state.node?.[0]).toBe(state.node?.[1]);
		expect(state.node?.[0]?.n).toBe(1);
	});

	it("replacing a self-referential container assigns the new cycle and restores the old on undo", () => {
		const state = createMutableState<{ n: number; node?: { m: number; self?: object } }>({ n: 1 });

		batch(() => {
			const node: { m: number; self?: object } = { m: 1 };

			node.self = node;
			state.node = node;
		});

		const heard = record(state);

		batch(() => {
			const next: { m: number; self?: object } = { m: 2 };

			next.self = next;
			state.node = next;
		});

		const delivered = heard[0] ?? [];

		expect(delivered[0]?.do).toMatchObject({ verb: "assign", path: ["node"] });
		expect(state.node?.self).toBe(state.node);
		expect(state.node?.m).toBe(2);

		replayUndo(state, delivered);
		expect(state.node?.m).toBe(1);
		expect(state.node?.self).toBe(state.node);
	});

	it("decomposes an assigned container whose interior reaches an interned occupied node", () => {
		const state = createMutableState<{ box: { inner: { n: number }; extra?: number } }>({
			box: { inner: { n: 1 } },
		});
		const inner = state.box.inner;
		const heard = record(state);

		batch(() => {
			state.box = { inner, extra: 2 };
		});

		const delivered = heard[0] ?? [];

		expect(delivered[0]?.do).toMatchObject({ verb: "assign", path: ["box"], value: {} });
		expect(delivered.some((pair) => pair.do.verb === "link" && pair.do.path[0] === "box")).toBe(true);
		expect(delivered.find((pair) => pair.do.verb === "link" && pair.do.path[1] === "inner")?.do).toMatchObject({
			verb: "link",
			path: ["box", "inner"],
			ref: internId(state, inner),
		});
		expect(state.box.inner).toBe(inner);
		expect(state.box.extra).toBe(2);
	});

	it("a second alias links to the route recorded earlier in the same batch", () => {
		const state = createMutableState<{
			first?: { n: number };
			wrapper?: { alias: { n: number } };
		}>({});
		const heard = record(state);

		batch(() => {
			const node = { n: 1 };

			state.first = node;
			state.wrapper = { alias: node };
		});

		const delivered = heard[0] ?? [];

		expect(shapeOps(delivered)).toEqual([
			{
				do: { verb: "assign", path: ["first"], value: { n: 1 }, ids: [1] },
				undo: { verb: "delete", path: ["first"] },
			},
			{
				do: { verb: "assign", path: ["wrapper"], value: {}, ids: [2] },
				undo: { verb: "delete", path: ["wrapper"] },
			},
			{
				do: { verb: "link", path: ["wrapper", "alias"], ref: internId(state, state.first!) },
				undo: { verb: "delete", path: ["wrapper", "alias"] },
			},
		]);
		expect(state.wrapper?.alias).toBe(state.first);
	});

	it("an ignore()d edge stays unoccupied and a shared descendant stays interned once", () => {
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
		expect(isIgnored(state.bag.wrap)).toBe(true);
		expect(internedOccupied(handle!, state.bag.wrap.secret)).toBe(false);
		expect(internedIdOf(handle!, state.bag.wrap.secret)).toBeUndefined();
		expect(internedOccupied(handle!, state.bag.left.child)).toBe(true);
		expect(internedIdOf(handle!, state.bag.left.child)).toBeDefined();
		expect(handle!.nodes.get(rawTargetOf(state.bag.left.child))?.edges.length).toBe(3);

		batch(() => {
			state.tick = 1;
		});

		expect(pathOf(heard[0])).toEqual([["tick"]]);
		expect(internedOccupied(handle!, state.bag.wrap.secret)).toBe(false);
		expect(internedIdOf(handle!, state.bag.wrap.secret)).toBeUndefined();
		expect(internedOccupied(handle!, state.bag.wrap)).toBe(false);
		expect(internedIdOf(handle!, state.bag.wrap)).toBeUndefined();
		expect(internedOccupied(handle!, state.bag.left.child)).toBe(true);
		expect(internedIdOf(handle!, state.bag.left.child)).toBeDefined();
		expect(state.bag.left.child).toBe(state.bag.right.child);
		expect(state.bag.left.child.self).toBe(state.bag.left.child);
	});

	it("assigning a container at a declared-ignored child vends no intern id there", () => {
		const state = createMutableState({
			bag: {
				wrap: ignore({ secret: { n: 1 } }),
				sibling: { n: 1 },
			},
		});
		const handle = requireHandle(state, "opshot: test requires a state");

		batch(() => {
			state.bag = {
				wrap: { secret: { n: 2 } },
				sibling: { n: 2 },
			};
		});

		expect(internedIdOf(handle, state.bag.wrap)).toBeDefined();
		expect(internedIdOf(handle, state.bag.wrap.secret)).toBeDefined();
		expect(internedIdOf(handle, state.bag.sibling)).toBeDefined();
	});

	it("an op whose path lands at a declared-ignored slot vends nothing through applyOperations", () => {
		const state = createMutableState({ wrap: ignore({ secret: { n: 1 } }), tick: 0 });
		const handle = requireHandle(state, "opshot: test requires a state");

		applyOperations(
			state,
			[{ do: createAssignMutation(["wrap"], { secret: { n: 2 } }), undo: createDeleteMutation(["wrap"]) }],
			"do",
		);

		expect(internedIdOf(handle, state.wrap.secret)).toBeDefined();
	});

	it("does not decompose when the only interned-occupied node sits under a declared-ignored child", () => {
		const state = createMutableState({
			bag: {
				wrap: ignore({ secret: { n: 1 } }),
				extra: 1,
			},
			keep: { n: 1 },
		});
		const heard = record(state);

		batch(() => {
			state.bag = { wrap: { secret: state.keep }, extra: 2 };
		});

		const delivered = heard[0] ?? [];

		expect(delivered[0]?.do).toMatchObject({ verb: "assign", path: ["bag"] });
		expect(delivered.some((pair) => pair.do.verb === "link")).toBe(true);
	});

	it("does not decompose when the interned-occupied child is under an aliased parent that declares the key ignored", () => {
		const state = createMutableState({
			a: { x: { n: 1 } },
			b: { x: ignore({ n: 1 }) },
			keep: { n: 1 },
		} as unknown as {
			a: { x: { n: number } | { n: number; extra?: number } };
			b: { x: { n: number } };
			keep: { n: number };
		});
		const heard = record(state);

		batch(() => {
			state.b = state.a;
		});

		batch(() => {
			const payload = { x: state.keep, extra: 2 };

			state.a = payload;
			state.b = payload;
		});

		const delivered = heard[1] ?? [];

		expect(delivered.some((pair) => pair.do.verb === "assign" && pair.do.path[0] === "a")).toBe(true);
		expect(delivered.some((pair) => pair.do.verb === "link" && pair.do.path[1] === "x")).toBe(true);
	});

	it("a frozen interned occupant ships by value with no link", () => {
		const state = createMutableState({ box: { inner: { n: 1 } } as { inner: object; extra?: number } });
		const inner = state.box.inner;
		const heard = record(state);

		Object.freeze(inner);

		batch(() => {
			state.box = { inner, extra: 2 };
		});

		const delivered = heard[0] ?? [];

		expect(delivered).toHaveLength(1);
		expect(delivered[0]?.do).toMatchObject({ verb: "assign", path: ["box"] });
		expect(delivered.some((pair) => pair.do.verb === "link")).toBe(false);
	});

	it("assigning a container behind a non-writable object property vends nothing for that child", () => {
		const locked = { n: 1 };
		const payload: { locked?: { n: number }; sibling: { n: number } } = { sibling: { n: 2 } };

		Object.defineProperty(payload, "locked", { value: locked, writable: false, enumerable: true });

		const state = createMutableState({ slot: { n: 0 } as object }, { strict: false });
		const handle = requireHandle(state, "opshot: test requires a state");

		batch(() => {
			state.slot = payload;
		});

		expect(internedIdOf(handle, locked)).toBeUndefined();
		expect(internedIdOf(handle, (state.slot as { sibling: { n: number } }).sibling)).toBeDefined();
	});

	it("a round trip of an aliased ignore nested in a payload keeps matching intern numbering", () => {
		const origin = createMutableState({
			a: { y: { n: 1 } },
			b: { y: ignore({ n: 1 }) },
			payload: undefined as { nest: { y: { n: number } } } | undefined,
		} as unknown as {
			a: { y: { n: number } };
			b: { y: { n: number } };
			payload?: { nest: { y: { n: number } } };
		});
		const heard = record(origin);

		batch(() => {
			origin.a = origin.b;
		});

		batch(() => {
			origin.payload = { nest: origin.a };
		});

		const replica = createMutableState({
			a: { y: { n: 1 } },
			b: { y: ignore({ n: 1 }) },
			payload: undefined as { nest: { y: { n: number } } } | undefined,
		} as unknown as {
			a: { y: { n: number } };
			b: { y: { n: number } };
			payload?: { nest: { y: { n: number } } };
		});

		for (const window of heard) applyOperations(replica, projectTransport(window), "do");

		const originHandle = requireHandle(origin, "opshot: test requires a state");
		const replicaHandle = requireHandle(replica, "opshot: test requires a state");

		expect(internSequenceOf(replica)).toEqual(internSequenceOf(origin));
		expect(replicaHandle.nextInternId).toBe(originHandle.nextInternId);
	});

	it("a same-window aliased parent with a fresh ignored child keeps matching intern numbering", () => {
		const origin = createMutableState({
			a: { x: { n: 1 } },
			b: { x: ignore({ n: 1 }) },
		} as unknown as { a: { x: { n: number }; extra?: number }; b: { x: { n: number }; extra?: number } });
		const heard = record(origin);

		batch(() => {
			const payload = { x: { n: 2 }, extra: 2 };

			origin.a = payload;
			origin.b = payload;
		});

		const replica = createMutableState({
			a: { x: { n: 1 } },
			b: { x: ignore({ n: 1 }) },
		} as unknown as { a: { x: { n: number }; extra?: number }; b: { x: { n: number }; extra?: number } });

		applyOperations(replica, projectTransport(heard[0] ?? []), "do");

		const originHandle = requireHandle(origin, "opshot: test requires a state");
		const replicaHandle = requireHandle(replica, "opshot: test requires a state");

		expect(internSequenceOf(replica)).toEqual(internSequenceOf(origin));
		expect(replicaHandle.nextInternId).toBe(originHandle.nextInternId);
		expect(internedIdOf(originHandle, origin.a.x)).toBeDefined();
		expect(internedIdOf(replicaHandle, replica.a.x)).toBeDefined();
	});

	it("a node aliased under an ignored edge keeps the id its tracked route earns", () => {
		const shared = { n: 1 };
		const state = createMutableState({
			keep: shared,
			bag: { wrap: ignore({ secret: shared }), sibling: { n: 2 } },
		});
		const handle = requireHandle(state, "opshot: test requires a state");
		const trackedId = internedIdOf(handle, state.keep);

		expect(trackedId).toBeDefined();

		batch(() => {
			state.bag = { wrap: { secret: state.keep }, sibling: { n: 3 } };
		});

		expect(internedIdOf(handle, state.keep)).toBe(trackedId);
	});

	it("an interned-occupied node under an ordinary tracked child still decomposes and links", () => {
		const state = createMutableState<{ box: { inner: { n: number }; extra?: number } }>({
			box: { inner: { n: 1 } },
		});
		const inner = state.box.inner;
		const heard = record(state);

		batch(() => {
			state.box = { inner, extra: 2 };
		});

		const delivered = heard[0] ?? [];

		expect(delivered[0]?.do).toMatchObject({ verb: "assign", path: ["box"], value: {} });
		expect(delivered.find((pair) => pair.do.verb === "link" && pair.do.path[1] === "inner")?.do).toMatchObject({
			verb: "link",
			path: ["box", "inner"],
			ref: internId(state, inner),
		});
	});

	it("keeps an assign that aliases through a previously ignored second route when the callback throws", () => {
		const state = createMutableState({
			a: { y: { n: 1 } },
			b: { y: ignore({ n: 1 }) },
			slot: { n: 0 } as object,
		} as unknown as { a: { y: { n: number } }; b: { y: { n: number } }; slot: object });

		batch(() => {
			state.b = state.a;
		});

		expect(() => {
			batch(() => {
				state.slot = { nest: state.a };
				throw new Error("abort");
			});
		}).toThrow("abort");

		expect(state.slot).toEqual({ nest: state.a });
		expect((state.slot as { nest: object }).nest).toBe(state.a);
	});

	it("a decomposed sparse-array addition skips holes and restores them on undo", () => {
		const shared = { n: 1 };
		const state = createMutableState<{ keep: { n: number }; list?: Array<{ n: number } | undefined> }>({
			keep: shared,
		});
		const heard = record(state);

		batch(() => {
			const list = new Array<{ n: number } | undefined>(4);

			list[0] = state.keep;
			list[3] = { n: 2 };
			state.list = list;
		});

		const delivered = heard[0] ?? [];

		expect(shapeOps(delivered)).toEqual([
			{ do: { verb: "assign", path: ["list"], value: [], ids: [2] }, undo: { verb: "delete", path: ["list"] } },
			{
				do: { verb: "assign", path: ["list", "length"], value: 4 },
				undo: { verb: "assign", path: ["list", "length"], value: 0 },
			},
			{
				do: { verb: "link", path: ["list", 0], ref: internId(state, state.keep) },
				undo: { verb: "delete", path: ["list", 0] },
			},
			{
				do: { verb: "assign", path: ["list", 3], value: { n: 2 }, ids: [3] },
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

describe("diffObjects: intern identity", () => {
	it("replays a mixed batch onto a replica with identical intern numbering", () => {
		const origin = createMutableState<{
			keep: { n: number };
			hub: { n: number; self?: object };
			list: Array<{ n: number }>;
			fresh?: { inner: { a: number }; extra: number };
			freshAlias?: { inner: { a: number }; extra: number };
			alias?: { n: number; self?: object };
			moved?: { n: number };
		}>({
			keep: { n: 0 },
			hub: { n: 1 },
			list: [{ n: 1 }, { n: 2 }, { n: 3 }],
		});
		const heard = record(origin);

		batch(() => {
			const fresh = { inner: { a: 1 }, extra: 2 };

			origin.fresh = fresh;
			origin.freshAlias = fresh;
			origin.alias = origin.hub;
			origin.moved = origin.keep;
			delete (origin as { keep?: { n: number } }).keep;
			origin.hub.self = origin.hub;
			origin.list.length = 1;
		});

		const replica = createMutableState<{
			keep: { n: number };
			hub: { n: number; self?: object };
			list: Array<{ n: number }>;
			fresh?: { inner: { a: number }; extra: number };
			freshAlias?: { inner: { a: number }; extra: number };
			alias?: { n: number; self?: object };
			moved?: { n: number };
		}>({
			keep: { n: 0 },
			hub: { n: 1 },
			list: [{ n: 1 }, { n: 2 }, { n: 3 }],
		});

		applyOperations(replica, projectTransport(heard[0] ?? []), "do");

		expect(replica.fresh).toBe(replica.freshAlias);
		expect(replica.alias).toBe(replica.hub);
		expect(replica.hub.self).toBe(replica.hub);
		expect(replica.moved).toEqual({ n: 0 });
		expect(Object.hasOwn(replica, "keep")).toBe(false);
		expect(replica.list).toHaveLength(1);
		expect(internSequenceOf(replica)).toEqual(internSequenceOf(origin));
		expect(internId(replica, replica.fresh!)).toBe(internId(replica, replica.freshAlias!));
		expect(internId(replica, replica.alias!)).toBe(internId(replica, replica.hub));
		expect(internId(origin, origin.fresh!)).toBe(internId(replica, replica.fresh!));
		expect(internId(origin, origin.hub)).toBe(internId(replica, replica.hub));
		expect(internId(origin, origin.moved!)).toBe(internId(replica, replica.moved!));
	});

	it("undoes a delete with a survivor to a link and a replica undo restores aliasing", () => {
		const shared = { n: 1 };
		const origin = createMutableState<{ a: { n: number }; b?: { n: number } }>({ a: shared, b: shared });
		const heard = record(origin);

		batch(() => {
			delete origin.b;
		});

		const delivered = heard[0] ?? [];

		expect(delivered).toHaveLength(1);
		expect(delivered[0]?.do).toMatchObject({ verb: "delete", path: ["b"] });
		expect(delivered[0]?.undo).toMatchObject({ verb: "link", path: ["b"], ref: internId(origin, origin.a) });

		const replicaShared = { n: 1 };
		const replica = createMutableState<{ a: { n: number }; b?: { n: number } }>({
			a: replicaShared,
			b: replicaShared,
		});

		applyOperations(replica, projectTransport(delivered), "do");
		expect(replica.b).toBeUndefined();
		expect(replica.a.n).toBe(1);

		applyOperations(replica, projectTransport(delivered), "undo");
		expect(replica.b).toBe(replica.a);
		expect(isSameIdentity(replica.b!, replica.a)).toBe(true);
	});

	it("links an interned overwrite of a scalar, null, or array index so a replica shares", () => {
		const replay = <T extends object>(
			start: () => T,
			write: (state: T) => void,
			shares: (state: T) => boolean,
		): void => {
			const origin = start();
			const heard = record(origin);

			batch(() => {
				write(origin);
			});

			expect(shares(origin)).toBe(true);

			const replica = start();

			applyOperations(replica, projectTransport(heard[0] ?? []), "do");
			expect(shares(replica)).toBe(true);
			expect(internSequenceOf(replica)).toEqual(internSequenceOf(origin));
		};

		replay(
			() => createMutableState({ shared: { n: 1 }, slot: 0 as number | { n: number } }),
			(state) => {
				state.slot = state.shared;
			},
			(state) => state.slot === state.shared,
		);
		replay(
			() => createMutableState({ shared: { n: 1 }, slot: null as { n: number } | null }),
			(state) => {
				state.slot = state.shared;
			},
			(state) => state.slot === state.shared,
		);
		replay(
			() => createMutableState({ list: [0, { n: 1 }] as Array<number | { n: number }> }),
			(state) => {
				state.list[0] = state.list[1]!;
			},
			(state) => state.list[0] === state.list[1],
		);
	});

	it("a refused container write never lands, so a later alias window matches intern numbering", async () => {
		const origin = createMutableState({
			bag: { keep: 1 } as { keep: number; drop?: Map<string, number> },
			extra: undefined as { n: number } | undefined,
			alias: undefined as { n: number } | undefined,
		});
		const heard = record(origin);

		expect(() => {
			origin.bag = { keep: 1, drop: new Map<string, number>() };
		}).toThrow("Map at /bag/drop cannot be tracked");

		origin.extra = { n: 1 };
		origin.alias = origin.extra;

		await Promise.resolve();

		const replica = createMutableState({
			bag: { keep: 1 } as { keep: number; drop?: Map<string, number> },
			extra: undefined as { n: number } | undefined,
			alias: undefined as { n: number } | undefined,
		});

		applyOperations(replica, projectTransport(heard[0] ?? []), "do");
		expect(replica.alias).toBe(replica.extra);
		expect(replica.bag).toEqual({ keep: 1 });
		expect(replica.bag).not.toHaveProperty("drop");
		expect(internSequenceOf(replica)).toEqual(internSequenceOf(origin));
		expect(internId(origin, origin.extra!)).toBe(internId(replica, replica.extra!));
	});

	it("links an alias overwriting a frozen occupant so a replica shares", () => {
		const frozen = Object.freeze({ x: 1 });
		const origin = createMutableState({
			shared: { n: 1 },
			slot: frozen as object,
			alias: undefined as { n: number } | undefined,
		});
		const heard = record(origin);

		batch(() => {
			origin.slot = origin.shared;
		});

		expect(heard[0]?.[0]?.do).toMatchObject({ verb: "link", path: ["slot"] });

		batch(() => {
			origin.alias = origin.shared;
		});

		const replica = createMutableState({
			shared: { n: 1 },
			slot: Object.freeze({ x: 1 }) as object,
			alias: undefined as { n: number } | undefined,
		});

		applyOperations(replica, projectTransport(heard[0] ?? []), "do");
		applyOperations(replica, projectTransport(heard[1] ?? []), "do");

		expect(replica.slot).toBe(replica.shared);
		expect(replica.alias).toBe(replica.shared);
	});

	it("does not name a frozen object assigned across windows so a later alias numbering matches", () => {
		const frozen = Object.freeze({ x: 1 });
		const origin = createMutableState({
			a: undefined as object | undefined,
			b: undefined as object | undefined,
			sh: undefined as { n: number } | undefined,
			alias: undefined as { n: number } | undefined,
		});
		const heard = record(origin);

		batch(() => {
			origin.a = frozen;
		});

		batch(() => {
			origin.b = frozen;
		});

		batch(() => {
			origin.sh = { n: 1 };
			origin.alias = origin.sh;
		});

		const replica = createMutableState({
			a: undefined as object | undefined,
			b: undefined as object | undefined,
			sh: undefined as { n: number } | undefined,
			alias: undefined as { n: number } | undefined,
		});

		applyOperations(replica, projectTransport(heard[0] ?? []), "do");
		applyOperations(replica, projectTransport(heard[1] ?? []), "do");
		applyOperations(replica, projectTransport(heard[2] ?? []), "do");

		expect(replica.alias).toBe(replica.sh);
		expect(internSequenceOf(replica)).toEqual(internSequenceOf(origin));
		expect(internId(origin, origin.sh!)).toBe(internId(replica, replica.sh!));
	});

	it("does not name a frozen array assigned across windows so a later alias numbering matches", () => {
		const frozen = Object.freeze([1]);
		const origin = createMutableState({
			a: undefined as object | undefined,
			b: undefined as object | undefined,
			sh: undefined as { n: number } | undefined,
			alias: undefined as { n: number } | undefined,
		});
		const heard = record(origin);

		batch(() => {
			origin.a = frozen;
		});

		batch(() => {
			origin.b = frozen;
		});

		batch(() => {
			origin.sh = { n: 1 };
			origin.alias = origin.sh;
		});

		const replica = createMutableState({
			a: undefined as object | undefined,
			b: undefined as object | undefined,
			sh: undefined as { n: number } | undefined,
			alias: undefined as { n: number } | undefined,
		});

		applyOperations(replica, projectTransport(heard[0] ?? []), "do");
		applyOperations(replica, projectTransport(heard[1] ?? []), "do");
		applyOperations(replica, projectTransport(heard[2] ?? []), "do");

		expect(replica.alias).toBe(replica.sh);
		expect(internSequenceOf(replica)).toEqual(internSequenceOf(origin));
		expect(internId(origin, origin.sh!)).toBe(internId(replica, replica.sh!));
	});
});

describe("diffObjects: identity occupancy", () => {
	it("assign-then-delete in one window emits a link at the new path before the delete at the old", () => {
		const state = createMutableState({
			dest: 0 as number | { n: number },
			src: { n: 1 },
		});
		const heard = record(state);

		batch(() => {
			state.dest = state.src;
			delete (state as { src?: { n: number } }).src;
		});

		const delivered = heard[0] ?? [];

		expect(shapeOps(delivered)).toEqual([
			{
				do: { verb: "link", path: ["dest"], ref: internId(state, state.dest as object) },
				undo: { verb: "assign", path: ["dest"], value: 0 },
			},
			{
				do: { verb: "delete", path: ["src"] },
				undo: { verb: "link", path: ["src"], ref: internId(state, state.dest as object) },
			},
		]);
	});

	it("delete-then-assign in one window emits a value assign with fresh ids", () => {
		const state = createMutableState({
			dest: 0 as number | { n: number },
			src: { n: 1 },
		});
		const held = state.src;
		const srcId = internId(state, held);
		const heard = record(state);

		batch(() => {
			delete (state as { src?: { n: number } }).src;
			state.dest = held;
		});

		const delivered = heard[0] ?? [];
		const destOp = delivered.find((operation) => operation.do.path[0] === "dest");

		expect(destOp?.do.verb).toBe("assign");
		expect((destOp?.do as AssignMutation).ids).toBeDefined();
		expect((destOp?.do as AssignMutation).ids).not.toContain(srcId);
		expect(internId(state, state.dest as object)).not.toBe(srcId);
	});
});

describe("tracked-only payloads", () => {
	it("an assign payload omits an edge to an ignored object", () => {
		const state = createMutableState({} as { a?: { x: number; hid?: { secret: number } } });
		const heard = record(state);

		batch(() => {
			state.a = { x: 1, hid: ignore({ secret: 1 }) };
		});

		const ops = heard[0] ?? [];

		expect(ops).toHaveLength(1);
		expect(ops[0]?.do).toMatchObject({ verb: "assign", path: ["a"] });
		expect(readValue(ops[0]?.do ?? { verb: "delete", path: [] })).toEqual({ x: 1 });
		expect(JSON.stringify(readValue(ops[0]?.do ?? { verb: "delete", path: [] }))).not.toContain("hid");
	});

	it("an assign payload omits an edge to a frozen object", () => {
		const state = createMutableState({} as { a?: { x: number; cfg?: { n: number } } });
		const heard = record(state);

		batch(() => {
			state.a = { x: 1, cfg: Object.freeze({ n: 1 }) };
		});

		const ops = heard[0] ?? [];

		expect(ops).toHaveLength(1);
		expect(readValue(ops[0]?.do ?? { verb: "delete", path: [] })).toEqual({ x: 1 });
	});

	it("an assign payload omits a dangerous edge value", () => {
		const state = createMutableState({} as { a?: { x: number; m?: Map<string, string> } }, { strict: false });
		const heard = record(state);

		batch(() => {
			state.a = { x: 1, m: new Map([["k", "v"]]) };
		});

		const ops = heard[0] ?? [];

		expect(ops).toHaveLength(1);
		expect(readValue(ops[0]?.do ?? { verb: "delete", path: [] })).toEqual({ x: 1 });

		const parsed = JSON.parse(JSON.stringify(ops)) as Array<Operation>;

		expect(JSON.parse(JSON.stringify(parsed))).toEqual(parsed);
		expect((parsed[0]?.do as AssignMutation).value).toEqual({ x: 1 });
	});

	it("an assign payload omits ride-alongs", () => {
		const payload: Record<PropertyKey, unknown> = { x: 1 };

		payload[Symbol("ride")] = { hidden: 1 };
		Object.defineProperty(payload, "hid", { value: { n: 1 }, enumerable: false, writable: true, configurable: true });
		Object.defineProperty(payload, "acc", {
			get: () => ({ n: 1 }),
			enumerable: true,
			configurable: true,
		});

		const state = createMutableState({} as { a?: Record<PropertyKey, unknown> });
		const heard = record(state);

		batch(() => {
			state.a = payload;
		});

		const value = readValue((heard[0] ?? [])[0]?.do ?? { verb: "delete", path: [] }) as object;

		expect(Reflect.ownKeys(value)).toEqual(["x"]);
	});

	it("a replacement's undo half omits untracked edges", () => {
		const state = createMutableState({} as { a?: { x: number; hid?: { secret: number }; cfg?: { n: number } } });
		const heard = record(state);

		batch(() => {
			state.a = { x: 1, hid: ignore({ secret: 1 }), cfg: Object.freeze({ n: 1 }) };
		});

		batch(() => {
			state.a = { x: 2 };
		});

		const replacement = (heard[1] ?? [])[0];

		expect(replacement?.do).toMatchObject({ verb: "assign", path: ["a"] });
		expect(readValue(replacement?.undo ?? { verb: "delete", path: [] })).toEqual({ x: 1 });
	});

	it("an ignored array element strips to a hole", () => {
		const state = createMutableState({} as { list?: Array<unknown>; tail?: Array<unknown> });
		const heard = record(state);

		batch(() => {
			state.list = [ignore({ n: 1 }), 2];
			state.tail = [2, ignore({ n: 1 })];
		});

		const delivered = heard[0] ?? [];
		const listValue = readValue(
			delivered.find((pair) => pair.do.path[0] === "list")?.do ?? { verb: "delete", path: [] },
		);
		const tailValue = readValue(
			delivered.find((pair) => pair.do.path[0] === "tail")?.do ?? { verb: "delete", path: [] },
		);

		expect(Object.hasOwn(listValue as object, 0)).toBe(false);
		expect((listValue as Array<unknown>)[1]).toBe(2);
		expect((listValue as Array<unknown>).length).toBe(2);
		expect((tailValue as Array<unknown>)[0]).toBe(2);
		expect(Object.hasOwn(tailValue as object, 1)).toBe(false);
		expect((tailValue as Array<unknown>).length).toBe(2);
	});

	it("a frozen occupant entering a slot emits nothing", () => {
		const state = createMutableState({} as { cfg?: { n: number } });
		const heard = record(state);

		batch(() => {
			state.cfg = Object.freeze({ n: 1 });
		});

		expect(heard).toEqual([]);
	});

	it("a replacement over a never-recorded occupant emits an addition", () => {
		const state = createMutableState({} as { a?: { secret: number } | { fresh: number } });
		const heard = record(state);

		batch(() => {
			state.a = ignore({ secret: 1 });
		});

		expect(heard).toEqual([]);

		batch(() => {
			state.a = { fresh: 1 };
		});

		const ops = heard[0] ?? [];
		const op = ops[0];

		expect(ops).toHaveLength(1);
		expect(op?.undo.verb).toBe("delete");
		expect(
			JSON.stringify([
				readValue(op?.do ?? { verb: "delete", path: [] }),
				readValue(op?.undo ?? { verb: "delete", path: [] }),
			]),
		).not.toContain("secret");
	});

	it("a deletion of a never-recorded occupant emits nothing", () => {
		const state = createMutableState({} as { hid?: { secret: number } });
		const heard = record(state);

		batch(() => {
			state.hid = ignore({ secret: 2 });
		});

		expect(heard).toEqual([]);

		batch(() => {
			delete state.hid;
		});

		expect(heard).toEqual([]);
	});

	it("a replacement of a never-recorded occupant by a primitive emits an addition", () => {
		const state = createMutableState({} as { a?: { secret: number } | number });
		const heard = record(state);

		batch(() => {
			state.a = ignore({ secret: 1 });
		});

		expect(heard).toEqual([]);

		batch(() => {
			state.a = 5;
		});

		const ops = heard[0] ?? [];
		const op = ops[0];

		expect(ops).toHaveLength(1);
		expect(op?.undo.verb).toBe("delete");
		expect(
			JSON.stringify([
				readValue(op?.do ?? { verb: "delete", path: [] }),
				readValue(op?.undo ?? { verb: "delete", path: [] }),
			]),
		).not.toContain("secret");
	});

	it("a held-ignored node keeps emitting through its kept edges", () => {
		const state = createMutableState({ doc: { title: "t" } });
		const heard = record(state);

		ignore(state.doc);

		batch(() => {
			state.doc.title = "t2";
		});

		expect(heard[0]).toHaveLength(1);
		expect(heard[0]?.[0]?.do).toMatchObject({ verb: "assign", path: ["doc", "title"], value: "t2" });
	});

	it("a TrackedMap's tracked entries ride the payload", () => {
		const state = createMutableState({} as { m?: TrackedMap<string, number> });
		const heard = record(state);

		batch(() => {
			state.m = new TrackedMap([["k", 1]]);
		});

		const value = readValue((heard[0] ?? [])[0]?.do ?? { verb: "delete", path: [] }) as object;

		for (const key of ["slots", "index", "count"] as const) {
			const descriptor = Reflect.getOwnPropertyDescriptor(value, key);

			expect(descriptor).toBeDefined();
			expect(descriptor !== undefined && "value" in descriptor).toBe(true);
		}
	});

	it("an ever-tracked occupant frozen through the proxy embeds a record-faithful undo on replacement", () => {
		const state = createMutableState({ a: { n: 1 } as { n: number } | { fresh: number } });
		const heard = record(state);

		batch(() => {
			Object.freeze(state.a);
		});

		heard.length = 0;

		batch(() => {
			state.a = { fresh: 1 };
		});

		expect(readValue((heard[0] ?? [])[0]?.undo ?? { verb: "delete", path: [] })).toEqual({ n: 1 });
	});

	it("an unsafeTrack'd occupant keeps emitting and riding", () => {
		const state = createMutableState({} as { m?: Map<unknown, unknown> });
		const heard = record(state);

		batch(() => {
			state.m = unsafeTrack(new Map());
		});

		const ops = heard[0] ?? [];

		expect(ops).toHaveLength(1);
		expect((ops[0]?.do as AssignMutation).ids).toBeDefined();
	});
});
