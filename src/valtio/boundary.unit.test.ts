import { createProxy } from "proxy-compare";
import { snapshot } from "valtio/vanilla";

import { createMutableState } from "../createMutableState";
import { edgeStatusOf } from "../edges";
import { applyOperations } from "../ops/applyOperations";
import { handleOf } from "../handle";
import { ignore } from "../ignore";
import { type Operation } from "../ops/operation";
import { shapeOps } from "../ops/operationShape";
import { subscribe } from "../subscribe";
import { TrackedMap } from "../tracked/trackedMap";
import { transact } from "../transact/transact";
import { unsafeTrack } from "../unsafeTrack";

const recordEmissions = <T extends object>(state: T): Array<{ state: T; ops: Array<Operation> }> => {
	const emissions = new Array<{ state: T; ops: Array<Operation> }>();

	subscribe(state, (ops) => {
		emissions.push({ state, ops: [...ops] });
	});

	return emissions;
};

const expectRefusedWrite = <T extends object>(
	state: T,
	write: (live: T) => void,
): Array<{ state: T; ops: Array<Operation> }> => {
	const emissions = recordEmissions(state);

	expect(() => {
		transact(state, () => {
			write(state);
		});
	}).toThrow(TypeError);

	return emissions;
};

const holderWithNonWritable = (child: object): Record<string, unknown> => {
	const holder: Record<string, unknown> = {};

	Object.defineProperty(holder, "held", {
		value: child,
		enumerable: true,
		writable: false,
		configurable: true,
	});

	return holder;
};

describe("boundary: tracked", () => {
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

	it("keeps identity when a popped proxy is reattached", () => {
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

describe("boundary: ride-alongs", () => {
	it("leaves an own __proto__ property untracked", () => {
		const carrier: { tick: number } = { tick: 0 };

		Object.defineProperty(carrier, "__proto__", { value: { polluted: true }, enumerable: true, writable: false });

		const state = createMutableState({ held: carrier });
		const emissions = recordEmissions(state);

		expect(Object.keys(state.held)).toContain("__proto__");

		transact(state, () => {
			state.held.tick = 1;
		});

		expect(emissions).toHaveLength(1);
		expect(JSON.stringify(emissions[0]?.ops)).not.toContain("__proto__");
		expect(Object.prototype).not.toHaveProperty("polluted");
	});

	it("leaves a symbol-keyed property untracked", () => {
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

	it("leaves a non-enumerable property untracked", () => {
		interface Counted {
			count: number;
			hidden?: number;
		}

		const literal: Counted = { count: 0 };

		Object.defineProperty(literal, "hidden", { value: 0, writable: true, enumerable: false, configurable: true });

		const state = createMutableState<Counted>(literal);
		const emissions = recordEmissions(state);

		transact(state, () => {
			state.hidden = 5;
		});

		expect(emissions).toHaveLength(0);
		expect(state.hidden).toBe(5);

		transact(state, () => {
			state.count = 1;
		});

		expect(emissions).toHaveLength(1);
		expect(shapeOps(emissions[0]?.ops ?? [])).toEqual([
			{ do: { verb: "assign", path: ["count"], value: 1 }, undo: { verb: "assign", path: ["count"], value: 0 } },
		]);
	});
});

describe("boundary: freeze", () => {
	it("makes every edge to a frozen node untracked", () => {
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
	});

	it("writes through a frozen container's interior without emission", () => {
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
});

describe("boundary: dangerous", () => {
	it("throws at the cause path of a nested assign", () => {
		const state = createMutableState<{ box: unknown }>({ box: null });

		expect(() => {
			transact(state, () => {
				state.box = { inner: { lookup: new Map<string, number>() } };
			});
		}).toThrow("opshot: Map at /box/inner/lookup cannot be tracked");
		expect(state.box).toBeNull();
	});

	it("throws at a non-writable property holding an object", () => {
		const outer = { lookup: new Map([["k", "v"]]) };
		const nested: Record<string, unknown> = {};

		Object.defineProperty(nested, "outer", {
			value: outer,
			enumerable: true,
			writable: false,
			configurable: true,
		});

		expect(() => createMutableState({ box: nested })).toThrow("opshot: Object at /box/outer cannot be tracked");
	});

	it("throws at a later enumerable function assignment onto a tracked class", () => {
		class Point {
			x = 1;
		}

		const state = createMutableState<{ point: Point & { fn?: () => number }; box: { fn?: () => number } }>({
			point: new Point(),
			box: {},
		});

		expect(() => {
			state.point.fn = () => 1;
		}).toThrow("opshot: Point at /fn cannot be tracked");
		expect(Object.hasOwn(state.point, "fn")).toBe(false);

		state.box.fn = () => 1;
		expect(typeof state.box.fn).toBe("function");
	});
});

describe("boundary: ignore", () => {
	it("makes the assigned edge untracked", () => {
		const lookup = new Map<string, number>();
		const state = createMutableState({ lookup: ignore(lookup), tick: 0 });
		const emissions = recordEmissions(state);

		expect(state.lookup).toBe(lookup);

		transact(state, () => {
			state.lookup.set("hits", 1);
		});

		expect(emissions).toHaveLength(0);
		expect(lookup.get("hits")).toBe(1);
	});

	it("tracks a later unmarked occupant after a create-time ignored assignment", () => {
		const state = createMutableState({ box: ignore(new Map([["k", 1]])), tick: 0 });
		const emissions = recordEmissions(state);
		const kept = new Map([["k", 2]]);

		expect(() => {
			transact(state, () => {
				state.box = kept;
				state.tick = 1;
			});
		}).toThrow("cannot be tracked");

		expect(emissions).toHaveLength(0);
	});

	it("leaves the interior of an ignored container uncertified", () => {
		const lookup = new Map<string, number>();

		expect(() => createMutableState({ kept: ignore({ lookup }) })).not.toThrow();
	});

	it("tracks a child reached by a separately assigned tracked edge", () => {
		const child = { n: 1 };
		const ignored = { child };
		const state = createMutableState({
			ignored: ignore(ignored),
		}) as { ignored: typeof ignored; tracked?: { n: number } };
		const emissions = recordEmissions(state);

		transact(state, () => {
			state.tracked = ignored.child;
		});

		expect(shapeOps(emissions[0]?.ops ?? [])).toEqual([
			{
				do: { verb: "assign", path: ["tracked"], value: { n: 1 }, ids: [1] },
				undo: { verb: "delete", path: ["tracked"] },
			},
		]);
		expect(state.ignored.child).toBe(child);

		emissions.length = 0;

		transact(state, () => {
			state.tracked!.n = 5;
		});

		expect(shapeOps(emissions[0]?.ops ?? [])).toEqual([
			{
				do: { verb: "assign", path: ["tracked", "n"], value: 5 },
				undo: { verb: "assign", path: ["tracked", "n"], value: 1 },
			},
		]);
		expect(state.tracked!.n).toBe(5);
		expect(ignored.child.n).toBe(5);
		expect(state.ignored.child.n).toBe(5);
	});
});

describe("boundary: strict false", () => {
	class Arrow {
		count = 0;
		bump = (): void => {
			this.count += 1;
		};
	}

	it("admits a clean class with own-enumerable functions and diffs plain fields at interior paths", () => {
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

	it("leaves an ignore()d member untracked", () => {
		const element = ignore({ node: "dom" });
		const state = createMutableState({ element }, { strict: false });
		const emissions = recordEmissions(state);

		transact(state, () => {
			state.element.node = "changed";
		});

		expect(emissions).toHaveLength(0);
		expect(state.element.node).toBe("changed");
	});

	it("refuses a loose-admitted Map assigned into a strict state without a new wrap", () => {
		const map = new Map<string, number>();
		const loose = createMutableState<{ lookup: Map<string, number> | null }>({ lookup: map }, { strict: false });
		const strict = createMutableState<{ box: Map<string, number> | null }>({ box: null });

		expect(() => {
			transact(strict, () => {
				strict.box = loose.lookup;
			});
		}).toThrow("Map at /box cannot be tracked");
		expect(strict.box).toBe(null);
	});

	it("admits a non-writable and a frozen child under non-strict, and a strict attach of a non-strict node carrying a non-writable interior throws", () => {
		const frozen = Object.freeze({ n: 1 });
		const locked = holderWithNonWritable({ n: 1 });

		expect(() => createMutableState({ locked, frozen }, { strict: false })).not.toThrow();

		const tracked = createMutableState({ inner: holderWithNonWritable({ n: 1 }) }, { strict: false });

		expect(() => createMutableState({ child: tracked })).toThrow("cannot be tracked");
	});
});

describe("boundary: refused writes", () => {
	it("refuses a sealed array's length truncation over a non-configurable index", () => {
		const state = createMutableState({ list: Object.seal([1, 2]) });
		const emissions = expectRefusedWrite(state, (live) => {
			live.list.length = 0;
		});

		expect(state.list).toEqual([1, 2]);
		expect(emissions).toHaveLength(0);
	});

	it("refuses an index extension over a non-writable length, leaving no hole", () => {
		const fixed = [1, 2];

		Object.defineProperty(fixed, "length", { writable: false });

		const state = createMutableState({ list: fixed });
		const emissions = expectRefusedWrite(state, (live) => {
			live.list[2] = 3;
		});

		expect(Object.hasOwn(state.list, 2)).toBe(false);
		expect(state.list).toHaveLength(2);
		expect(emissions).toHaveLength(0);
	});

	it("refuses a write to a non-writable data property like the raw engine", () => {
		const raw: { a?: number } = {};
		const box: { a?: number } = {};

		Object.defineProperty(raw, "a", { value: 1, writable: false, enumerable: true, configurable: true });
		Object.defineProperty(box, "a", { value: 1, writable: false, enumerable: true, configurable: true });

		expect(() => {
			raw.a = 1;
		}).toThrow(TypeError);

		const state = createMutableState({ box });
		const emissions = expectRefusedWrite(state, (live) => {
			live.box.a = 1;
		});

		expect(state.box.a).toBe(1);
		expect(emissions).toHaveLength(0);
	});

	it("refuses a write to an inherited getter-only accessor, leaving no own key", () => {
		class Gauge {
			count = 2;

			get doubled(): number {
				return this.count * 2;
			}
		}

		const state = createMutableState(new Gauge()) as Gauge & { doubled: number };
		const emissions = expectRefusedWrite(state, (live) => {
			live.doubled = 9;
		});

		expect(Object.hasOwn(state, "doubled")).toBe(false);
		expect(state.doubled).toBe(4);
		expect(emissions).toHaveLength(0);
	});
});

describe("boundary: snapshot donation", () => {
	it("refuses assigning a snapshot generation, including through a tracking wrapper", () => {
		const source = createMutableState({ item: { value: 1 } });
		const destination = createMutableState<{ box: unknown }>({ box: null });
		const donated = snapshot(source).item;
		const wrapped = createProxy(donated as object, new WeakMap(), new WeakMap(), new WeakMap());

		const donate = (value: unknown): void => {
			transact(destination, () => {
				destination.box = value;
			});
		};

		expect(() => donate(donated)).toThrow('opshot: cannot assign a snapshot generation at "box"');
		expect(destination.box).toBe(null);

		expect(() => donate(wrapped)).toThrow('opshot: cannot assign a snapshot generation at "box"');
		expect(destination.box).toBe(null);
	});
});

describe("boundary: meta-mutation", () => {
	it("completes Object.setPrototypeOf on a tracked node with no op", () => {
		const state = createMutableState({ count: 0 });
		const emissions = recordEmissions(state);

		Object.setPrototypeOf(state, null);
		transact(state, () => undefined);

		expect(Object.getPrototypeOf(state)).toBeNull();
		expect(emissions).toHaveLength(0);
	});
});

describe("boundary: in-edges", () => {
	it("climbs a cyclic graph without hanging and classifies occupied nodes", () => {
		const state = createMutableState({ box: { n: 1 } as { n: number; self?: { n: number } } });

		transact(state, () => {
			state.box.self = state.box;
		});

		const handle = handleOf(state);

		if (handle === undefined) throw new Error("expected a handle");

		const status = edgeStatusOf(handle, state.box);

		expect(status.occupied).toBe(true);

		transact(state, () => {
			state.box.n = 2;
		});

		expect(state.box.n).toBe(2);
		expect(state.box.self).toBe(state.box);
	});

	it("removes in-edges of truncated array elements", () => {
		const state = createMutableState({ list: [{ n: 1 }] });
		const handle = handleOf(state);

		if (handle === undefined) throw new Error("expected a handle");

		const occupant = state.list[0];

		if (occupant === undefined) throw new Error("expected an occupant");

		expect(edgeStatusOf(handle, occupant).occupied).toBe(true);

		transact(state, () => {
			state.list.length = 0;
		});

		expect(edgeStatusOf(handle, occupant).occupied).toBe(false);
	});
});

class ArrowBox {
	x = 1;
	bump = (): void => {
		this.x += 1;
	};
}

describe("boundary: trap admission", () => {
	it("a strict plain dangerous write throws at the statement, the slot is unchanged, nothing emits, and the next window emits normally", async () => {
		const state = createMutableState({ x: null as unknown, tick: 0 });
		const emissions = recordEmissions(state);

		expect(() => {
			state.x = new Map();
		}).toThrow("Map at /x cannot be tracked");
		expect(state.x).toBeNull();

		await Promise.resolve();

		expect(emissions).toHaveLength(0);

		state.tick = 1;

		await Promise.resolve();

		expect(emissions.map((emission) => shapeOps(emission.ops))).toEqual([
			[{ do: { verb: "assign", path: ["tick"], value: 1 }, undo: { verb: "assign", path: ["tick"], value: 0 } }],
		]);
	});

	it("a strict assignment of a container carrying a dangerous interior throws naming the relative cause and nothing lands", () => {
		const state = createMutableState<{ box: unknown }>({ box: null });

		expect(() => {
			state.box = { keep: 1, bad: new Map() };
		}).toThrow("Map at /box/bad cannot be tracked");
		expect(state.box).toBeNull();
	});

	it("a cleanClass own-function interior throws the same way", () => {
		const state = createMutableState<{ box: unknown }>({ box: null });

		expect(() => {
			state.box = new ArrowBox();
		}).toThrow("ArrowBox at /box/bump cannot be tracked");
		expect(state.box).toBeNull();
	});

	it("strictest-wins: a dangerous write through a non-strict handle throws when a strict handle also holds the node", () => {
		const strictState = createMutableState(
			{ shared: null as { n: number; bad?: Map<string, number> } | null, tick: 0 },
			{ strict: true },
		);
		const looseState = createMutableState(
			{ shared: null as { n: number; bad?: Map<string, number> } | null, tick: 0 },
			{ strict: false },
		);

		strictState.shared = { n: 1 };
		looseState.shared = strictState.shared;

		const shared = looseState.shared;

		if (shared === null) throw new Error("expected a shared node");

		expect(() => {
			shared.bad = new Map();
		}).toThrow("Map at /bad cannot be tracked");
		expect(Object.hasOwn(strictState.shared as object, "bad")).toBe(false);
		expect(Object.hasOwn(looseState.shared as object, "bad")).toBe(false);
	});

	it("a cross-state attach of a non-strict-admitted node carrying dangerous interior into a strict state throws", () => {
		const loose = createMutableState({ node: { keep: 1, bad: new Map<string, number>() } }, { strict: false });
		const strict = createMutableState<{ box: unknown }>({ box: null });

		expect(() => {
			strict.box = loose.node;
		}).toThrow("Map at /box/bad cannot be tracked");
		expect(strict.box).toBeNull();
	});

	it("TrackedMap.set of a dangerous value under strict throws at the statement", () => {
		const state = createMutableState({ lookup: new TrackedMap<string, unknown>() });

		expect(() => {
			state.lookup.set("bad", new Map());
		}).toThrow("cannot be tracked");
		expect(state.lookup.has("bad")).toBe(false);
	});
});

describe("boundary: trap admission across states", () => {
	it("a write nested inside a non-strict state's frame is judged by the strict state it writes into", async () => {
		const doc = createMutableState({ annotations: null as unknown, tick: 0 }, { strict: true });
		const emissions = recordEmissions(doc);

		class Panel {
			set selection(value: unknown) {
				doc.annotations = value;
			}
		}

		const ui = createMutableState({ panel: new Panel() }, { strict: false });

		expect(() => {
			ui.panel.selection = new Map();
		}).toThrow("Map at /annotations cannot be tracked");
		expect(doc.annotations).toBeNull();

		doc.tick = 1;

		await Promise.resolve();

		expect(emissions.map((emission) => shapeOps(emission.ops))).toEqual([
			[{ do: { verb: "assign", path: ["tick"], value: 1 }, undo: { verb: "assign", path: ["tick"], value: 0 } }],
		]);
	});

	it("a write nested inside a strict state's frame is judged by the non-strict state it writes into", () => {
		const loose = createMutableState({ sink: null as unknown }, { strict: false });

		class Relay {
			set forward(value: unknown) {
				loose.sink = value;
			}
		}

		const strict = createMutableState({ relay: new Relay() }, { strict: true });

		strict.relay.forward = new Map([["k", 1]]);

		expect(loose.sink).toBeInstanceOf(Map);
	});

	it("the unsafeTrack exemption does not cross into a clean strict state", () => {
		const target = createMutableState({ clean: null as unknown }, { strict: true });

		class Cross {
			set gate(value: unknown) {
				target.clean = value;
			}
		}

		const source = createMutableState({ zone: unsafeTrack({ cross: new Cross() }) }, { strict: true });

		expect(() => {
			source.zone.cross.gate = new Map();
		}).toThrow("Map at /clean cannot be tracked");
		expect(target.clean).toBeNull();
	});

	it("a strict state stops judging a node it no longer holds", async () => {
		const state = createMutableState<{ a?: { keep: number; bad?: unknown } }>({ a: { keep: 1 } });

		recordEmissions(state);

		const held = state.a;

		if (held === undefined) throw new Error("expected a held node");

		delete state.a;

		await Promise.resolve();

		held.bad = new Map();

		expect(held.bad).toBeInstanceOf(Map);
	});

	it("a node held only by a non-strict state admits dangerous material after a strict state releases it", async () => {
		const strict = createMutableState<{ a?: { keep: number; bad?: unknown } }>({ a: { keep: 1 } });

		recordEmissions(strict);

		const held = strict.a;

		if (held === undefined) throw new Error("expected a held node");

		delete strict.a;

		await Promise.resolve();

		const loose = createMutableState<{ n: unknown }>({ n: null }, { strict: false });

		loose.n = held;

		await Promise.resolve();

		held.bad = new Map();

		expect(held.bad).toBeInstanceOf(Map);
	});

	it("detaching a node from an unsafe zone leaves it no stricter than it was", async () => {
		const zone: { holder?: { n: number; ok?: unknown; later?: unknown } } = { holder: { n: 1 } };
		const state = createMutableState({ zone: unsafeTrack(zone) });

		recordEmissions(state);

		const holder = state.zone.holder;

		if (holder === undefined) throw new Error("expected a holder");

		holder.ok = new Map();

		await Promise.resolve();

		delete state.zone.holder;

		await Promise.resolve();

		holder.later = new Map();

		expect(holder.later).toBeInstanceOf(Map);
	});

	it("a write through a prototype accessor is a ride-along the trap leaves to the setter", () => {
		const landed = new Array<unknown>();

		class Sink {
			set gate(value: unknown) {
				landed.push(value);
			}
		}

		const state = createMutableState({ sink: new Sink() }, { strict: true });

		state.sink.gate = new Map([["k", 1]]);

		expect(landed).toHaveLength(1);
		expect(Object.hasOwn(state.sink, "gate")).toBe(false);
	});

	it("a function assigned through a prototype accessor is left to the setter, which is judged where it stores", () => {
		class Gate {
			kept: unknown = null;

			set gate(value: unknown) {
				this.kept = value;
			}
		}

		const admitting = createMutableState({ holder: new Gate() }, { strict: true });

		expect(() => {
			admitting.holder.gate = () => 1;
		}).toThrow("Gate at /kept cannot be tracked");
		expect(Object.hasOwn(admitting.holder, "gate")).toBe(false);

		class PlainStore {
			store: Record<string, unknown> = {};

			set gate(value: unknown) {
				this.store.fn = value;
			}
		}

		const state = createMutableState({ holder: new PlainStore() }, { strict: true });

		state.holder.gate = () => 1;

		expect(typeof state.holder.store.fn).toBe("function");
	});

	it("a non-enumerable dangerous property inside an assigned subtree is a ride-along the assignment admits", async () => {
		const state = createMutableState<{ slot: { keep: number } | null; tick: number }>(
			{ slot: null, tick: 0 },
			{ strict: true },
		);
		const emissions = recordEmissions(state);
		const payload = { keep: 1 };

		Object.defineProperty(payload, "hidden", { value: new Map(), enumerable: false, writable: true });

		state.slot = payload;

		await Promise.resolve();

		expect(state.slot?.keep).toBe(1);
		expect(emissions.flatMap((emission) => emission.ops.map((operation) => operation.do.path.join("/")))).toEqual([
			"slot",
		]);

		const replica = createMutableState<{ slot: { keep: number } | null; tick: number }>(
			{ slot: null, tick: 0 },
			{ strict: true },
		);

		for (const emission of emissions)
			applyOperations(replica, JSON.parse(JSON.stringify(emission.ops)) as Array<Operation>, "do");

		expect(replica.slot?.keep).toBe(1);
		expect(Object.hasOwn(replica.slot as object, "hidden")).toBe(false);
	});

	it("a refused compound array mutator keeps the prefix it already landed and emits it", async () => {
		const state = createMutableState({ list: [1, 2, 3] as Array<unknown> });
		const emissions = recordEmissions(state);

		expect(() => {
			state.list.splice(1, 0, new Map());
		}).toThrow("cannot be tracked");

		await Promise.resolve();

		expect(state.list).toEqual([1, 2, 2, 3]);
		expect(emissions.flatMap((emission) => emission.ops.map((operation) => operation.do.path.join("/")))).toEqual([
			"list/2",
			"list/length",
			"list/3",
		]);
	});

	it("the same compound mutator inside transact restores whole", async () => {
		const state = createMutableState({ list: [1, 2, 3] as Array<unknown> });
		const emissions = recordEmissions(state);

		expect(() => {
			transact(state, () => {
				state.list.splice(1, 0, new Map());
			});
		}).toThrow("cannot be tracked");

		await Promise.resolve();

		expect(state.list).toEqual([1, 2, 3]);
		expect(emissions).toHaveLength(0);
	});
});
