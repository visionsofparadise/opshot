import { createProxy } from "proxy-compare";
import { snapshot } from "valtio/vanilla";

import { createMutableState } from "../createMutableState";
import { ignore } from "../ignore";
import { type Operation } from "../ops/operation";
import { shapeOps } from "../ops/operationShape";
import { subscribe } from "../subscribe";
import { transact } from "../transact/transact";

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

		const state = createMutableState<{ point: Point & { fn?: () => number } }>({ point: new Point() });

		expect(() => {
			transact(state, () => {
				state.point.fn = () => 1;
			});
		}).toThrow("opshot: Point at /point/fn cannot be tracked");
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

	it("keeps a create-time ignored path untracked after a later assign", () => {
		const state = createMutableState({ box: ignore(new Map([["k", 1]])), tick: 0 });
		const emissions = recordEmissions(state);
		const kept = new Map([["k", 2]]);

		transact(state, () => {
			state.box = kept;
			state.tick = 1;
		});

		expect(emissions).toHaveLength(1);
		expect(shapeOps(emissions[0]?.ops ?? [])).toEqual([
			{ do: { verb: "assign", path: ["tick"], value: 1 }, undo: { verb: "assign", path: ["tick"], value: 0 } },
		]);
		expect(state.box).toBe(kept);
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
				do: { verb: "assign", path: ["tracked"], value: { n: 1 } },
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

	it("walks past a non-writable and a frozen child and skips an already-tracked node", () => {
		const frozen = Object.freeze({ n: 1 });
		const locked = holderWithNonWritable({ n: 1 });

		expect(() => createMutableState({ locked, frozen }, { strict: false })).not.toThrow();

		const tracked = createMutableState({ inner: holderWithNonWritable({ n: 1 }) }, { strict: false });
		const nested = createMutableState({ child: tracked });

		expect(nested.child).toBe(tracked);
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
