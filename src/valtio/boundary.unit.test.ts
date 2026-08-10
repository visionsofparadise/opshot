import { subscribe } from "../subscribe";
import { transact } from "../transact";
import { createProxy } from "proxy-compare";
import { snapshot } from "valtio/vanilla";

import { installBoundary } from "./boundary";
import { createMutableState } from "../createMutableState";
import { peelIdentityLayer } from "../identity";
import { applyOperations } from "../ops/applyOperations";
import { type Operation } from "../ops/operation";
import { ignore } from "../ignore";
import { isUnsafeTracked, unsafeTrack } from "../unsafeTrack";
import { shapeOps } from "../ops/operationShape";

const recordEmissions = <T extends object>(state: T): Array<{ state: T; ops: Array<Operation> }> => {
	const emissions = new Array<{ state: T; ops: Array<Operation> }>();

	subscribe(state, (ops) => {
		emissions.push({ state, ops: [...ops] });
	});

	return emissions;
};

describe("boundary: tracked lane", () => {
	it("tracks nested plain objects and arrays with fine-grained ops", () => {
		const state = createMutableState({ document: { title: "a", tags: ["x", "y"] } });
		const emissions = recordEmissions(state);

		transact(state, () => {
			state.document.title = "b";
		});

		transact(state, () => {
			state.document.tags[1] = "z";
		});

		expect(emissions.map((emission) => shapeOps(emission.ops))).toEqual([
			[
				{
					do: { verb: "assign", path: ["document", "title"], value: "b" },
					undo: { verb: "assign", path: ["document", "title"], value: "a" },
				},
			],
			[
				{
					do: { verb: "assign", path: ["document", "tags", 1], value: "z" },
					undo: { verb: "assign", path: ["document", "tags", 1], value: "y" },
				},
			],
		]);
	});

	it("tracks an iterable plain object with fine-grained ops", () => {
		const state = createMutableState({
			collection: {
				count: 0,
				[Symbol.iterator]: function* () {
					yield 1;
				},
			},
		});
		const emissions = recordEmissions(state);

		transact(state, () => {
			state.collection.count = 1;
		});

		expect(emissions).toHaveLength(1);
		expect(shapeOps(emissions[0]?.ops ?? [])).toEqual([
			{
				do: { verb: "assign", path: ["collection", "count"], value: 1 },
				undo: { verb: "assign", path: ["collection", "count"], value: 0 },
			},
		]);
		expect(state.collection.count).toBe(1);
	});
});

describe("boundary: sparse-array snapshots", () => {
	it("restores a trailing-hole length after a proxied length write", () => {
		const state = createMutableState({ values: [1, 2, 3] });

		transact(state, () => {
			state.values.length = 5;
		});

		const values = state.values;

		expect(values).toHaveLength(5);
		expect(Object.hasOwn(values, 3)).toBe(false);
		expect(Object.hasOwn(values, 4)).toBe(false);
	});

	it("preserves mixed interior and trailing holes", () => {
		const state = createMutableState({ values: [1, 2, 3] });

		transact(state, () => {
			delete state.values[1];
			state.values.length = 6;
		});

		const values = state.values;

		expect(values).toHaveLength(6);
		expect(values[0]).toBe(1);
		expect(values[2]).toBe(3);
		expect([1, 3, 4, 5].map((index) => Object.hasOwn(values, index))).toEqual([false, false, false, false]);
	});

	it("leaves dense-array snapshots unchanged", () => {
		const values = createMutableState({ values: [1, 2, 3] }).values;

		expect(values).toEqual([1, 2, 3]);
		expect(Reflect.ownKeys(values)).toEqual(["0", "1", "2", "length"]);
	});
});

describe("boundary: snapshot donation", () => {
	it("throws at the assigned key before a snapshot copy creates a dead region", () => {
		const source = createMutableState({ item: { value: 1 } });
		const destination = createMutableState<{ box: unknown }>({ box: null });
		const donated = snapshot(source).item;

		expect(peelIdentityLayer(donated as object)).not.toBeUndefined();

		expect(() => {
			transact(destination, () => {
				destination.box = donated;
			});
		}).toThrow(
			'opshot: cannot assign a snapshot generation at "box": a snapshot generation is a read-view, and assigning it creates a dead region. Clone the value, or replay through applyOperations.',
		);
		expect(destination.box).toBe(null);
	});

	it("unwraps a tracking wrapper before rejecting its registered snapshot copy", () => {
		const source = createMutableState({ item: { value: 1 } });
		const donated = snapshot(source).item;
		const wrapped = createProxy(donated as object, new WeakMap(), new WeakMap(), new WeakMap());
		const destination = createMutableState<{ box: unknown }>({ box: null });

		expect(() => {
			transact(destination, () => {
				destination.box = wrapped;
			});
		}).toThrow("Clone the value, or replay through applyOperations");
		expect(destination.box).toBe(null);
	});

	it("admits a raw object target", () => {
		const raw = { value: 1 };
		const state = createMutableState<{ box: { value: number } | null }>({ box: null });

		transact(state, () => {
			state.box = raw;
		});

		expect(state.box).toEqual({ value: 1 });
	});

	it("admits a popped proxy when the same target is reattached", () => {
		interface Item {
			value: number;
		}

		const target = { value: 1 };
		const state = createMutableState<{ items: Array<Item> }>({ items: [target] });
		let popped: Item | undefined;

		transact(state, () => {
			popped = state.items.pop();
		});
		transact(state, () => {
			if (popped) state.items.push(popped);
		});

		expect(state.items).toEqual([{ value: 1 }]);

		transact(state, () => {
			const item = state.items[0];

			if (item) item.value = 9;
		});

		expect(target.value).toBe(9);
	});
});

describe("boundary: throws at entry", () => {
	it("rejects a __proto__ data key wherever it is placed", () => {
		const withOwnProto = () => {
			const carrier = {};

			Object.defineProperty(carrier, "__proto__", { value: { polluted: true }, enumerable: true, writable: true });

			return carrier;
		};

		expect(() => createMutableState(withOwnProto())).toThrow("own __proto__ key is not supported on tracked state");
		expect(() => createMutableState({ held: withOwnProto() })).toThrow(
			"own __proto__ key is not supported on tracked state",
		);

		const state = createMutableState<{ value: unknown }>({ value: null });

		expect(() => {
			transact(state, () => {
				state.value = { deep: withOwnProto() };
			});
		}).toThrow("own __proto__ key is not supported on tracked state");
		expect(state.value).toBeNull();
		expect(Object.prototype).not.toHaveProperty("polluted");
	});

	it("admits a non-writable __proto__ data key visible on the live proxy and absent from snapshots and ops", () => {
		const carrier: { tick: number } = { tick: 0 };

		Object.defineProperty(carrier, "__proto__", { value: { polluted: true }, enumerable: true, writable: false });

		const state = createMutableState({ held: carrier });
		const emissions = recordEmissions(state);

		expect(Object.keys(state.held)).toContain("__proto__");
		expect(JSON.stringify(state.held)).toContain("polluted");

		const snap = snapshot(state);

		expect(Object.hasOwn(snap.held, "__proto__")).toBe(false);
		expect(JSON.stringify(snap)).not.toContain("polluted");

		transact(state, () => {
			state.held.tick = 1;
		});

		expect(emissions).toHaveLength(1);
		expect(JSON.stringify(emissions[0]?.ops)).not.toContain("__proto__");
		expect(Object.prototype).not.toHaveProperty("polluted");
	});

	it("treats constructor and prototype as ordinary data keys", () => {
		const state = createMutableState<{ h: { constructor: { note: number; prototype?: object } } }>({
			h: { constructor: { note: 1 } },
		});

		transact(state, () => {
			state.h.constructor.prototype = { x: 1 };
		});

		expect(state.h.constructor.prototype).toEqual({ x: 1 });
		expect(state.h.constructor).not.toBe(Object);
		expect(Object.prototype).not.toHaveProperty("x");
		expect({}).not.toHaveProperty("x");
	});

	it("certifies a rejectable value inside a deeply aliased diamond", () => {
		let node: Record<string, unknown> = { leaf: true };

		for (let level = 0; level < 24; level++) node = { left: node, right: node };

		node.hidden = new Map();

		expect(() => createMutableState({ graph: node })).toThrow("Map at /graph/hidden");
	});

	it("throws for a non-writable object route before consulting a writable route to the same value", () => {
		const shared: Record<string, unknown> = { held: { hidden: new Map() } };
		const carrier: Record<string, unknown> = {};

		Object.defineProperty(carrier, "sealed", {
			value: shared,
			enumerable: true,
			writable: false,
			configurable: true,
		});
		carrier.open = shared;

		expect(() => createMutableState({ carrier })).toThrow(
			"opshot: Object at /carrier/sealed cannot be tracked (a non-writable property's interior is silently mutable and untracked)",
		);
	});

	it("rejects a rejectable value reachable by two writable routes", () => {
		const shared: Record<string, unknown> = { hidden: new Map() };
		const carrier: Record<string, unknown> = { first: shared, second: shared };

		expect(() => createMutableState({ carrier })).toThrow("opshot: Map at /carrier/first/hidden cannot be tracked");
	});

	it("rejects a __proto__ write through the trap under default strictness", () => {
		const state = createMutableState<{ value: unknown }>({ value: null });
		const carrier = {};

		Object.defineProperty(carrier, "__proto__", { value: { polluted: true }, enumerable: true, writable: true });

		expect(() => {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			(state as any).__proto__ = {};
		}).toThrow("own __proto__ key is not supported on tracked state");

		expect(() => {
			transact(state, () => {
				state.value = carrier;
			});
		}).toThrow("own __proto__ key is not supported on tracked state");

		expect(state.value).toBeNull();
		expect(Reflect.getPrototypeOf(state)).toBe(Object.prototype);
	});

	it("tracks a clean class instance with fine-grained interior ops", () => {
		class Emitter {
			count = 0;
		}

		const state = createMutableState({ emitter: new Emitter() });
		const emissions = recordEmissions(state);

		transact(state, () => {
			state.emitter.count = 1;
		});

		expect(emissions).toHaveLength(1);
		expect(shapeOps(emissions[0]?.ops ?? [])).toEqual([
			{
				do: { verb: "assign", path: ["emitter", "count"], value: 1 },
				undo: { verb: "assign", path: ["emitter", "count"], value: 0 },
			},
		]);
		expect(state.emitter).toBeInstanceOf(Emitter);
		expect(state.emitter.count).toBe(1);
	});
});

describe("boundary: located rejection", () => {
	it("names which of two rejectable values in one initializer was rejected", () => {
		expect(() =>
			createMutableState({ first: { lookup: new Map<string, number>() }, second: { members: new Set<string>() } }),
		).toThrow("opshot: Map at /first/lookup cannot be tracked");

		expect(() =>
			createMutableState({ first: { members: new Set<string>() }, second: { lookup: new Map<string, number>() } }),
		).toThrow("opshot: Set at /first/members cannot be tracked");
	});

	it("tracks the offending path rather than reporting a fixed location", () => {
		expect(() => createMutableState({ first: { lookup: new Map<string, number>() }, second: { ok: 1 } })).toThrow(
			"opshot: Map at /first/lookup cannot be tracked",
		);
		expect(() => createMutableState({ first: { ok: 1 }, second: { members: new Set<string>() } })).toThrow(
			"opshot: Set at /second/members cannot be tracked",
		);
	});

	it("composes the written key with the relative path beneath it", () => {
		const state = createMutableState<{ box: unknown }>({ box: null });

		expect(() => {
			transact(state, () => {
				state.box = { inner: { lookup: new Map<string, number>() } };
			});
		}).toThrow("opshot: Map at /box/inner/lookup cannot be tracked");
		expect(state.box).toBeNull();
	});
});

describe("boundary: certification descends only where valtio proxies", () => {
	it("throws at admission for an object behind a non-writable property and rejects it behind a writable one", () => {
		const held = new Map([["k", "v"]]);
		const nonWritable: Record<string, unknown> = {};

		Object.defineProperty(nonWritable, "held", {
			value: held,
			enumerable: true,
			writable: false,
			configurable: true,
		});

		expect(() => createMutableState({ box: nonWritable })).toThrow(
			"opshot: Map at /box/held cannot be tracked (a non-writable property's interior is silently mutable and untracked). Options:\n- make the property writable\n- ignore(value) to declare the escape",
		);

		const writable: Record<string, unknown> = {};

		Object.defineProperty(writable, "held", {
			value: new Map([["k", "v"]]),
			enumerable: true,
			writable: true,
			configurable: true,
		});

		expect(() => createMutableState({ box: writable })).toThrow("opshot: Map at /box/held cannot be tracked");
	});

	it("throws at the non-writable property itself rather than descending its subtree", () => {
		const outer = { lookup: new Map([["k", "v"]]) };
		const nested: Record<string, unknown> = {};

		Object.defineProperty(nested, "outer", {
			value: outer,
			enumerable: true,
			writable: false,
			configurable: true,
		});

		expect(() => createMutableState({ box: nested })).toThrow(
			"opshot: Object at /box/outer cannot be tracked (a non-writable property's interior is silently mutable and untracked)",
		);
	});

	it("throws the admission error at a consumer write's located path", () => {
		const state = createMutableState<{ box: unknown }>({ box: null });
		const fixed: Record<string, unknown> = {};

		Object.defineProperty(fixed, "inner", {
			value: { n: 1 },
			enumerable: true,
			writable: false,
			configurable: true,
		});

		expect(() => {
			transact(state, () => {
				state.box = { holder: fixed };
			});
		}).toThrow(
			"opshot: Object at /box/holder/inner cannot be tracked (a non-writable property's interior is silently mutable and untracked)",
		);
		expect(state.box).toBeNull();
	});

	it("admits a non-writable primitive as a ride-along, present and untracked", () => {
		const carrier: { label?: string; tick: number } = { tick: 0 };

		Object.defineProperty(carrier, "label", {
			value: "fixed",
			enumerable: true,
			writable: false,
			configurable: true,
		});

		const state = createMutableState({ box: carrier });
		const emissions = recordEmissions(state);

		expect(state.box.label).toBe("fixed");

		transact(state, () => {
			state.box.tick = 1;
		});

		expect(emissions).toHaveLength(1);
		expect(JSON.stringify(emissions[0]?.ops)).not.toContain("label");
		expect(state.box.label).toBe("fixed");
	});

	it("admits a frozen container as a leaf whose non-writable interior never reaches the admission throw", () => {
		const inner = { n: 1 };
		const frozen = Object.freeze({ inner });
		const state = createMutableState({ frozen, tick: 0 });
		const emissions = recordEmissions(state);

		expect(state.frozen).toBe(frozen);

		transact(state, () => {
			state.frozen.inner.n = 2;
		});

		expect(inner.n).toBe(2);
		expect(emissions).toHaveLength(0);
	});

	it("leaves the interior of an ignored container uncertified on both paths", () => {
		const lookup = new Map<string, number>();

		expect(() => createMutableState({ kept: ignore({ lookup }) })).not.toThrow();
		expect(() => createMutableState({ kept: ignore({ a: { b: new Set<string>() } }) })).not.toThrow();
		expect(() => createMutableState({ kept: ignore([new Map<string, number>()]) })).not.toThrow();

		const state = createMutableState<{ box: unknown }>({ box: null });

		transact(state, () => {
			state.box = ignore({ lookup });
		});

		expect((state.box as { lookup: Map<string, number> }).lookup).toBe(lookup);
	});

	it("reports no location rather than a wrong one for a placement the walk cannot see", () => {
		const nested: Record<string, unknown> = {};
		const symbolKeyed: Record<string | symbol, unknown> = {};

		Object.defineProperty(nested, "held", {
			value: new Map<string, number>(),
			enumerable: false,
			writable: true,
			configurable: true,
		});
		Object.defineProperty(symbolKeyed, Symbol("held"), {
			value: new Map<string, number>(),
			enumerable: true,
			writable: true,
			configurable: true,
		});

		for (const carrier of [nested, symbolKeyed]) {
			let message = "";

			try {
				createMutableState({ a: { b: carrier } });
			} catch (error) {
				message = error instanceof Error ? error.message : String(error);
			}

			expect(message).toContain("opshot: Map cannot be tracked");
			expect(message).not.toContain(" at /");
		}
	});

	it("admits a __proto__ carrier inside an ignored container, landing by reference", () => {
		const carrier = {};

		Object.defineProperty(carrier, "__proto__", { value: { polluted: true }, enumerable: true, writable: true });

		const state = createMutableState({ kept: ignore({ held: carrier }) });

		expect(state.kept.held).toBe(carrier);
		expect(Object.keys(state.kept.held)).toContain("__proto__");
		expect(Reflect.getPrototypeOf(state.kept.held)).toBe(Object.prototype);
		expect(Object.prototype).not.toHaveProperty("polluted");
	});

	it("admits an ignored value behind a non-writable property as the declared escape", () => {
		const carrier = {};

		Object.defineProperty(carrier, "__proto__", { value: { polluted: true }, enumerable: true, writable: true });

		const nested: Record<string, unknown> = {};

		Object.defineProperty(nested, "held", {
			value: ignore(carrier),
			enumerable: true,
			writable: false,
			configurable: true,
		});

		const state = createMutableState({ box: nested });

		expect(state.box.held).toBe(carrier);
		expect(Object.keys(state.box.held as object)).toContain("__proto__");
		expect(Reflect.getPrototypeOf(state.box.held as object)).toBe(Object.prototype);
		expect(Object.prototype).not.toHaveProperty("polluted");
	});
});

describe("boundary: admitted by rule", () => {
	it("auto-ignores a frozen plain object: same reference through snapshots, no ops, interior write throws", () => {
		const frozen = Object.freeze({ value: 1 });
		const state = createMutableState({ box: frozen, tick: 0 });
		const emissions = recordEmissions(state);

		expect(state.box).toBe(frozen);

		transact(state, () => {
			state.tick = 1;
		});

		expect(emissions).toHaveLength(1);
		expect(shapeOps(emissions[0]?.ops ?? [])).toEqual([
			{ do: { verb: "assign", path: ["tick"], value: 1 }, undo: { verb: "assign", path: ["tick"], value: 0 } },
		]);
		expect(state.box).toBe(frozen);

		expect(() => {
			transact(state, () => {
				(state.box as { value: number }).value = 2;
			});
		}).toThrow(TypeError);
	});

	it("carries a symbol-keyed prop into snapshots, bumping the version without emission on write", () => {
		const marker: unique symbol = Symbol("marker");

		interface Flagged {
			count: number;
			[marker]: string;
		}

		const state = createMutableState<Flagged>({ count: 0, [marker]: "initial" });
		const emissions = recordEmissions(state);

		expect(state[marker]).toBe("initial");

		transact(state, () => {
			state[marker] = "written";
		});

		expect(emissions).toHaveLength(0);
		expect(state[marker]).toBe("written");
	});

	it("carries a non-enumerable prop into snapshots, absent from ops, bumping the version without emission on write", () => {
		interface Counted {
			count: number;
			hidden?: number;
		}

		const literal: Counted = { count: 0 };

		Object.defineProperty(literal, "hidden", { value: 0, writable: true, enumerable: false, configurable: true });

		const state = createMutableState<Counted>(literal);
		const emissions = recordEmissions(state);

		expect(Object.getOwnPropertyDescriptor(state, "hidden")).toMatchObject({ value: 0, enumerable: false });

		transact(state, () => {
			state.hidden = 5;
		});

		expect(emissions).toHaveLength(0);

		transact(state, () => {
			state.count = 1;
		});

		expect(emissions).toHaveLength(1);
		expect(shapeOps(emissions[0]?.ops ?? [])).toEqual([
			{ do: { verb: "assign", path: ["count"], value: 1 }, undo: { verb: "assign", path: ["count"], value: 0 } },
		]);

		const emitted = emissions[0]?.state;

		if (!emitted) throw new Error("the state heard no emission");

		expect(Object.getOwnPropertyDescriptor(emitted, "hidden")).toMatchObject({ value: 5, enumerable: false });
	});

	it("keeps functions as identity leaves", () => {
		const first = (): string => "a";
		const second = (): string => "b";

		const state = createMutableState({ run: first });
		const emissions = recordEmissions(state);

		transact(state, () => {
			state.run = second;
		});

		expect(emissions).toHaveLength(1);
		expect(shapeOps(emissions[0]?.ops ?? [])).toEqual([
			{
				do: { verb: "assign", path: ["run"], value: second },
				undo: { verb: "assign", path: ["run"], value: first },
			},
		]);
		expect(state.run).toBe(second);
	});
});

describe("boundary: ignore lane", () => {
	it("admits an ignored Map by reference, untracked and silent", () => {
		const lookup = ignore(new Map<string, number>());
		const state = createMutableState({ lookup, tick: 0 });
		const emissions = recordEmissions(state);

		expect(state.lookup).toBe(lookup);

		transact(state, () => {
			state.lookup.set("hits", 1);
		});

		expect(emissions).toHaveLength(0);
		expect(lookup.get("hits")).toBe(1);
	});

	it("admits an ignored value at the assigning line", () => {
		interface Box {
			box: Map<string, number> | null;
		}

		const state = createMutableState<Box>({ box: null });
		const emissions = recordEmissions(state);
		const kept = ignore(new Map([["k", 1]]));

		transact(state, () => {
			state.box = kept;
		});

		expect(emissions).toHaveLength(1);
		expect(state.box).toBe(kept);
	});

	it("allows writes through a snapshot copy of an ignored value", () => {
		const lookup = ignore(new Map<string, number>([["a", 1]]));
		const state = createMutableState({ lookup });
		const snap = snapshot(state);

		expect(() => {
			snap.lookup.set("b", 2);
		}).not.toThrow();
		expect(lookup.get("b")).toBe(2);
		expect(state.lookup).toBe(lookup);
	});
});

describe("boundary: meta-mutation trap gates", () => {
	it("throws when a consumer calls Object.defineProperty on tracked state", () => {
		const state = createMutableState({ count: 0 });

		expect(() => Object.defineProperty(state, "extra", { value: 1 })).toThrow(
			"opshot: defineProperty is not supported on tracked state; define properties in the createMutableState input (meta-mutation has no faithful operation representation)",
		);
	});

	it("throws when a consumer calls Object.setPrototypeOf on tracked state", () => {
		const state = createMutableState({ count: 0 });

		expect(() => Object.setPrototypeOf(state, null)).toThrow(
			"opshot: setPrototypeOf is not supported on tracked state; set the prototype before the value enters state (meta-mutation has no faithful operation representation)",
		);
	});

	it("keeps defineProperty rejection local to each proxy handler", () => {
		const second = createMutableState({ count: 0 });
		const first = createMutableState({
			get trigger(): number {
				return 0;
			},
			set trigger(value: number) {
				Object.defineProperty(second, "injected", { value });
			},
		});

		expect(() => {
			transact(first, () => {
				first.trigger = 1;
			});
		}).toThrow("opshot: defineProperty is not supported on tracked state");
		expect(Object.hasOwn(second, "injected")).toBe(false);
	});

	it("throws when a consumer calls Object.preventExtensions, freeze, or seal, leaving no side effect behind", () => {
		const state = createMutableState<{ count: number; items: Array<number>; added?: number }>({
			count: 0,
			items: [1, 2],
		});
		const emissions = recordEmissions(state);

		expect(() => Object.preventExtensions(state)).toThrow(
			"opshot: preventExtensions is not supported on tracked state; freeze the value before it enters state (meta-mutation has no faithful operation representation)",
		);
		expect(() => Object.freeze(state)).toThrow("opshot: preventExtensions is not supported on tracked state");
		expect(() => Object.seal(state)).toThrow("opshot: preventExtensions is not supported on tracked state");
		expect(() => Object.preventExtensions(state.items)).toThrow(
			"opshot: preventExtensions is not supported on tracked state",
		);
		expect(() => Object.freeze(state.items)).toThrow("opshot: preventExtensions is not supported on tracked state");
		expect(() => Object.seal(state.items)).toThrow("opshot: preventExtensions is not supported on tracked state");

		expect(Object.isExtensible(state)).toBe(true);
		expect(Object.isExtensible(state.items)).toBe(true);

		transact(state, () => {
			state.added = 1;
			state.items.push(3);
		});

		expect(state.added).toBe(1);
		expect(state.items).toEqual([1, 2, 3]);
		expect(2 in state.items).toBe(true);
		expect(emissions).toHaveLength(1);
	});

	it("leaves freezing a snapshot and an op's recorded value untouched", () => {
		const state = createMutableState<{ document: { title: string } }>({ document: { title: "a" } });
		const emissions = recordEmissions(state);

		transact(state, () => {
			state.document = { title: "b" };
		});

		const recorded = emissions[0]?.ops[0]?.undo;

		if (recorded?.verb !== "assign") throw new Error("missing recorded assign");

		const undoValue = recorded.value;

		expect(() => Object.freeze(undoValue as object)).not.toThrow();
		expect(Object.isFrozen(undoValue as object)).toBe(true);

		const snap = snapshot(state);

		expect(() => Object.freeze(snap)).not.toThrow();
		expect(Object.isFrozen(snap)).toBe(true);
	});

	it("leaves ordinary set, delete, and nested writes through mutate unaffected", () => {
		interface Nested {
			count: number;
			hidden?: number;
			child: { value: number };
		}

		const state = createMutableState<Nested>({ count: 0, hidden: 1, child: { value: 1 } });
		const emissions = recordEmissions(state);

		transact(state, () => {
			state.count = 1;
			state.child.value = 9;
			state.child = { value: 20 };
			delete state.hidden;
		});

		expect(state.count).toBe(1);
		expect(state.child.value).toBe(20);
		expect(state.hidden).toBeUndefined();
		expect(emissions).toHaveLength(1);
	});
});

describe("boundary: refused writes", () => {
	it("throws a native TypeError for an added key on a sealed child, leaving no key and no op", () => {
		const state = createMutableState<{ box: { a: number; b?: number } }>({ box: Object.seal({ a: 1 }) });
		const emissions = recordEmissions(state);

		expect(() => {
			transact(state, () => {
				state.box.b = 9;
			});
		}).toThrow(TypeError);

		expect(Object.hasOwn(state.box, "b")).toBe(false);
		expect(emissions).toHaveLength(0);
	});

	it("raises on a sealed array's push, leaving no hole and no length op", () => {
		const state = createMutableState({ list: Object.seal([1, 2]) });
		const emissions = recordEmissions(state);

		expect(() => {
			transact(state, () => {
				state.list.push(3);
			});
		}).toThrow(TypeError);

		expect(state.list).toEqual([1, 2]);
		expect(state.list).toHaveLength(2);
		expect(Object.hasOwn(state.list, 2)).toBe(false);
		expect(emissions).toHaveLength(0);
	});

	it("raises on a sealed array's length truncation, leaving the array unchanged", () => {
		const state = createMutableState({ list: Object.seal([1, 2]) });
		const emissions = recordEmissions(state);

		expect(() => {
			transact(state, () => {
				state.list.length = 0;
			});
		}).toThrow(TypeError);

		expect(state.list).toEqual([1, 2]);
		expect(state.list).toHaveLength(2);
		expect(emissions).toHaveLength(0);
	});

	it("raises on an index extension over a non-writable length, which still attaches", () => {
		const fixed = [1, 2];

		Object.defineProperty(fixed, "length", { writable: false });

		const state = createMutableState({ list: fixed });
		const emissions = recordEmissions(state);

		expect(state.list).toEqual([1, 2]);

		expect(() => {
			transact(state, () => {
				state.list[2] = 3;
			});
		}).toThrow(TypeError);

		expect(Object.hasOwn(state.list, 2)).toBe(false);
		expect(state.list).toHaveLength(2);
		expect(emissions).toHaveLength(0);
	});

	it("lands a sealed child's existing-key write and emits its assign op", () => {
		const state = createMutableState({ box: Object.seal({ a: 1 }) });
		const emissions = recordEmissions(state);

		transact(state, () => {
			state.box.a = 2;
		});

		expect(state.box.a).toBe(2);
		expect(emissions.map((emission) => shapeOps(emission.ops))).toEqual([
			[
				{
					do: { verb: "assign", path: ["box", "a"], value: 2 },
					undo: { verb: "assign", path: ["box", "a"], value: 1 },
				},
			],
		]);
	});

	it("refuses an inherited writable-data key on a sealed child like a new key", () => {
		const state = createMutableState({ box: Object.seal({ a: 1 }) });

		expect(() => {
			transact(state, () => {
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				(state.box as any).toString = (): string => "written";
			});
		}).toThrow(TypeError);

		expect(Object.hasOwn(state.box, "toString")).toBe(false);
	});

	it("keeps delete on a sealed child throwing", () => {
		const state = createMutableState<{ box: { a?: number } }>({ box: Object.seal({ a: 1 }) });

		expect(() => {
			transact(state, () => {
				delete state.box.a;
			});
		}).toThrow(TypeError);

		expect(state.box.a).toBe(1);
	});

	it("refuses a write to an inherited getter-only accessor, leaving no own key and no op", () => {
		class Gauge {
			count = 2;

			get doubled(): number {
				return this.count * 2;
			}
		}

		const state = createMutableState(new Gauge());
		const emissions = recordEmissions(state);

		expect(() => {
			transact(state, () => {
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				(state as any).doubled = 9;
			});
		}).toThrow(TypeError);

		expect(Object.hasOwn(state, "doubled")).toBe(false);
		expect(state.doubled).toBe(4);
		expect(emissions).toHaveLength(0);
	});

	it("delegates a write to an inherited accessor with a setter and emits the setter's data write", () => {
		class Gauge {
			count = 2;

			get doubled(): number {
				return this.count * 2;
			}

			set doubled(value: number) {
				this.count = value / 2;
			}
		}

		const state = createMutableState(new Gauge());
		const emissions = recordEmissions(state);

		transact(state, () => {
			state.doubled = 6;
		});

		expect(state.count).toBe(3);
		expect(emissions.map((emission) => shapeOps(emission.ops))).toEqual([
			[
				{
					do: { verb: "assign", path: ["count"], value: 3 },
					undo: { verb: "assign", path: ["count"], value: 2 },
				},
			],
		]);
	});

	it("refuses a same-value write to a non-writable property like the raw engine", () => {
		const box: { a?: number } = {};

		Object.defineProperty(box, "a", { value: 1, writable: false, enumerable: true, configurable: true });

		const state = createMutableState({ box });
		const emissions = recordEmissions(state);

		expect(() => {
			transact(state, () => {
				state.box.a = 1;
			});
		}).toThrow(TypeError);

		expect(state.box.a).toBe(1);
		expect(emissions).toHaveLength(0);
	});
});

describe("boundary: install", () => {
	it("installs idempotently", () => {
		installBoundary();
		installBoundary();

		const state = createMutableState({ count: 0 });

		transact(state, () => {
			state.count = 1;
		});

		expect(state.count).toBe(1);
		expect(() => createMutableState({ lookup: new Map<string, number>() })).toThrow(
			"opshot: Map at /lookup cannot be tracked",
		);
	});
});

describe("boundary: strict false", () => {
	class Arrow {
		count = 0;
		bump = (): void => {
			this.count += 1;
		};
	}

	it("reproduces explicit unsafeTrack interior ops and undo/redo", () => {
		const nonStrict = createMutableState({ arrow: new Arrow() }, { strict: false });
		const explicit = createMutableState({ arrow: unsafeTrack(new Arrow()) });
		const nonStrictHeard = recordEmissions(nonStrict);
		const explicitHeard = recordEmissions(explicit);

		transact(nonStrict, () => {
			nonStrict.arrow.count = 5;
		});
		transact(explicit, () => {
			explicit.arrow.count = 5;
		});

		const expected = [
			{
				do: { verb: "assign", path: ["arrow", "count"], value: 5 },
				undo: { verb: "assign", path: ["arrow", "count"], value: 0 },
			},
		];

		expect(nonStrictHeard.map((emission) => shapeOps(emission.ops))).toEqual([expected]);
		expect(explicitHeard.map((emission) => shapeOps(emission.ops))).toEqual([expected]);

		const op = nonStrictHeard[0]!.ops[0]!;

		applyOperations(nonStrict, [op], "undo");
		expect(nonStrict.arrow.count).toBe(0);

		applyOperations(nonStrict, [op], "do");
		expect(nonStrict.arrow.count).toBe(5);
	});

	it("attaches a clean class with own-enumerable functions and diffs plain fields at interior paths", () => {
		const state = createMutableState({ arrow: new Arrow() }, { strict: false });
		const emissions = recordEmissions(state);

		transact(state, () => {
			state.arrow.count = 3;
		});

		expect(emissions.map((emission) => shapeOps(emission.ops))).toEqual([
			[
				{
					do: { verb: "assign", path: ["arrow", "count"], value: 3 },
					undo: { verb: "assign", path: ["arrow", "count"], value: 0 },
				},
			],
		]);
	});

	it("attaches a Map and throws on first map.set", () => {
		const state = createMutableState({ lookup: new Map<string, number>() }, { strict: false });

		expect(state.lookup).toBeInstanceOf(Map);
		expect(() => state.lookup.set("a", 1)).toThrow();
	});

	it("attaches a #private class and throws when a method reads private state", () => {
		class Vault {
			#secret = 7;
			public label = "a";

			reveal(): number {
				return this.#secret;
			}
		}

		const state = createMutableState({ vault: new Vault() }, { strict: false });

		expect(state.vault.label).toBe("a");
		expect(() => state.vault.reveal()).toThrow();
	});

	it("attaches an array subclass and seeds a plain-array snapshot", () => {
		class TaggedArray extends Array<number> {
			tag = "tagged";
		}

		const state = createMutableState({ values: new TaggedArray(1, 2) }, { strict: false });
		const snap = snapshot(state);

		expect(Array.isArray(snap.values)).toBe(true);
		expect(Object.getPrototypeOf(snap.values)).toBe(Array.prototype);
		expect(Object.getPrototypeOf(state.values)).not.toBe(Array.prototype);
	});

	it("tracks plain objects and arrays exactly as under strict true", () => {
		const nonStrict = createMutableState({ document: { title: "a", tags: ["x", "y"] } }, { strict: false });
		const strict = createMutableState({ document: { title: "a", tags: ["x", "y"] } });
		const nonStrictHeard = recordEmissions(nonStrict);
		const strictHeard = recordEmissions(strict);

		transact(nonStrict, () => {
			nonStrict.document.title = "b";
			nonStrict.document.tags[1] = "z";
		});
		transact(strict, () => {
			strict.document.title = "b";
			strict.document.tags[1] = "z";
		});

		expect(nonStrictHeard.map((emission) => emission.ops)).toEqual(strictHeard.map((emission) => emission.ops));
	});

	it("still auto-ignores a frozen plain object while marking a frozen Map", () => {
		const frozenPlain = Object.freeze({ x: 1 });
		const frozenMap = Object.freeze(new Map<string, number>());
		const state = createMutableState({ box: frozenPlain, lookup: frozenMap }, { strict: false });

		expect(isUnsafeTracked(frozenPlain)).toBe(false);
		expect(isUnsafeTracked(frozenMap)).toBe(true);
		expect(() => state.lookup.set("a", 1)).toThrow();
	});

	it("still leaves a refSet member as a leaf", () => {
		const element = ignore({ node: "dom" });
		const state = createMutableState({ element }, { strict: false });
		const emissions = recordEmissions(state);

		transact(state, () => {
			state.element.node = "changed";
		});

		expect(emissions).toHaveLength(0);
		expect(state.element.node).toBe("changed");
	});

	it("admission travels with the value into a later strict state", () => {
		const map = new Map<string, number>();
		const nonStrict = createMutableState({ lookup: map }, { strict: false });

		expect(isUnsafeTracked(map)).toBe(true);

		const strict = createMutableState({ lookup: nonStrict.lookup });

		expect(strict.lookup).toBe(nonStrict.lookup);
		expect(() => strict.lookup.set("a", 1)).toThrow();
	});

	it("skips certification on the write path, deferring the throw to first use", () => {
		const state = createMutableState<{ box: unknown }>({ box: null }, { strict: false });

		transact(state, () => {
			state.box = new Map<string, number>();
		});

		expect(state.box).toBeInstanceOf(Map);
		expect(() => (state.box as Map<string, number>).set("a", 1)).toThrow();
	});

	it("keeps the reserved-path guard running on both paths", () => {
		const withOwnProto = () => {
			const carrier = {};

			Object.defineProperty(carrier, "__proto__", { value: { polluted: true }, enumerable: true, writable: true });

			return carrier;
		};

		expect(() => createMutableState({ held: withOwnProto() }, { strict: false })).toThrow(
			"own __proto__ key is not supported on tracked state",
		);

		const state = createMutableState<{ value: unknown }>({ value: null }, { strict: false });

		expect(() => {
			transact(state, () => {
				state.value = { deep: withOwnProto() };
			});
		}).toThrow("own __proto__ key is not supported on tracked state");
		expect(state.value).toBeNull();
	});

	it("keeps every non-admission loud site under strict false", () => {
		const state = createMutableState({ count: 0 }, { strict: false });

		expect(() => {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			(state as any).__proto__ = {};
		}).toThrow("own __proto__ key is not supported");

		expect(() => {
			Object.defineProperty(state, "extra", { value: 1 });
		}).toThrow("defineProperty is not supported");

		expect(() => {
			Object.setPrototypeOf(state, {});
		}).toThrow("setPrototypeOf is not supported");

		const source = createMutableState({ item: { value: 1 } }, { strict: false });
		const snap = snapshot(source);

		expect(() => {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			(state as any).donated = (snap as any).item;
		}).toThrow(/snapshot|donation|registered/i);
	});

	it("gives a rejectable value nested below a replayed property no location at all", () => {
		const carrier = (): object => {
			const holder = {};

			Object.defineProperty(holder, "b", {
				value: { hidden: { m: new Map() } },
				enumerable: false,
				writable: true,
				configurable: true,
			});

			return holder;
		};

		expect(() => createMutableState({ a: carrier() })).toThrow("opshot: Map cannot be tracked");
		expect(() => createMutableState({ a: carrier() })).not.toThrow(/ at \//);
		expect(() => createMutableState({ outer: { a: carrier() } })).not.toThrow(/ at \//);
	});

	it("still names the key and the relative path beneath a consumer's own assignment", () => {
		const state = createMutableState<{ a: { b: object } }>({ a: { b: {} } });

		expect(() => {
			state.a.b = { hidden: { m: new Map() } };
		}).toThrow("opshot: Map at /b/hidden/m cannot be tracked");
	});
});
