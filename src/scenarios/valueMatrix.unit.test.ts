import { createMutableState } from "../createMutableState";
import { requireHandle } from "../handle";
import { ignore } from "../ignore";
import { isSameIdentity } from "../identity";
import { internedIdOf } from "../intern";
import { isState } from "../isState";

import { applyOperations } from "../ops/applyOperations";
import { type Operation } from "../ops/operation";
import { subscribe } from "../subscribe";
import { transact } from "../transact/transact";
import { unsafeTrack } from "../unsafeTrack";

const record = <T extends object>(state: T): Array<Array<Operation>> => {
	const heard = new Array<Array<Operation>>();

	subscribe(state, (ops) => {
		heard.push([...ops]);
	});

	return heard;
};

const cloneOperations = (ops: ReadonlyArray<Operation>): Array<Operation> =>
	JSON.parse(JSON.stringify(ops)) as Array<Operation>;

class PrivateBox {
	#secret = 1;
	x = 0;

	reveal(): number {
		return this.#secret;
	}
}

class ArrowBox {
	x = 1;
	bump = (): void => {
		this.x += 1;
	};
}

const nonWritableObjectCarrier = (): object => {
	const nested: Record<string, unknown> = {};

	Object.defineProperty(nested, "outer", {
		value: { n: 1 },
		enumerable: true,
		writable: false,
		configurable: true,
	});

	return nested;
};

describe("JSON leaf", () => {
	it("create", () => {
		const state = createMutableState({ n: 42 });

		expect(isState(state)).toBe(true);
		expect(state.n).toBe(42);
	});

	it("admit", () => {
		const state = createMutableState<{ n?: number }>({});

		transact(state, () => {
			state.n = 42;
		});

		expect(state.n).toBe(42);
	});

	it("in-place write", () => {
		const state = createMutableState({ n: 42 });
		const heard = record(state);

		transact(state, () => {
			state.n = 43;
		});

		expect(state.n).toBe(43);
		expect(heard[0]?.[0]?.do).toMatchObject({ verb: "assign", path: ["n"], value: 43 });
	});

	it("delete", () => {
		const state = createMutableState<{ n?: number }>({ n: 42 });
		const heard = record(state);

		transact(state, () => {
			delete state.n;
		});

		expect(state.n).toBeUndefined();
		expect(heard[0]?.[0]?.do).toMatchObject({ verb: "delete", path: ["n"] });
	});

	it("clone", () => {
		const state = createMutableState({ n: 42 });
		const heard = record(state);

		transact(state, () => {
			state.n = 43;
		});

		const cloned = cloneOperations(heard[0] ?? []);

		expect(cloned[0]?.do).toMatchObject({ verb: "assign", path: ["n"], value: 43 });
	});

	it("apply", () => {
		const state = createMutableState({ n: 42 });
		const heard = record(state);

		transact(state, () => {
			state.n = 43;
		});

		applyOperations(state, heard[0] ?? [], "undo");
		expect(state.n).toBe(42);

		applyOperations(state, heard[0] ?? [], "do");
		expect(state.n).toBe(43);
	});

	it("clone-apply", () => {
		const state = createMutableState({ n: 42 });
		const heard = record(state);

		transact(state, () => {
			state.n = 43;
		});

		const replica = createMutableState({ n: 42 });

		applyOperations(replica, cloneOperations(heard[0] ?? []), "do");
		expect(replica.n).toBe(43);
		expect(isSameIdentity(replica, state)).toBe(false);
	});

	it("rollback", () => {
		const state = createMutableState({ n: 42 });
		const heard = record(state);

		expect(() =>
			transact(state, () => {
				state.n = 43;

				throw new Error("abort");
			}),
		).toThrow("abort");

		expect(state.n).toBe(42);
		expect(heard).toEqual([]);
	});
});

describe("tracked object", () => {
	it("create", () => {
		const state = createMutableState({ box: { a: 1 } });

		expect(isState(state)).toBe(true);
		expect(state.box.a).toBe(1);
	});

	it("admit", () => {
		const state = createMutableState<{ box?: { a: number } }>({});

		transact(state, () => {
			state.box = { a: 1 };
		});

		expect(state.box?.a).toBe(1);
	});

	it("in-place write", () => {
		const state = createMutableState({ box: { a: 1 } });
		const heard = record(state);

		transact(state, () => {
			state.box.a = 2;
		});

		expect(state.box.a).toBe(2);
		expect(heard[0]?.[0]?.do).toMatchObject({ verb: "assign", path: ["box", "a"], value: 2 });
	});

	it("replace", () => {
		const state = createMutableState({ box: { a: 1 } });
		const held = state.box;
		const heard = record(state);

		transact(state, () => {
			state.box = { a: 9 };
		});

		expect(state.box.a).toBe(9);
		expect(isSameIdentity(state.box, held)).toBe(false);
		expect(heard[0]?.[0]?.do).toMatchObject({ verb: "assign", path: ["box"] });
	});

	it("delete", () => {
		const state = createMutableState<{ box?: { a: number } }>({ box: { a: 1 } });
		const heard = record(state);

		transact(state, () => {
			delete state.box;
		});

		expect(state.box).toBeUndefined();
		expect(heard[0]?.[0]?.do).toMatchObject({ verb: "delete", path: ["box"] });
	});

	it("alias", () => {
		const shared = { n: 1 };
		const state = createMutableState({ left: shared, right: shared });
		const heard = record(state);

		transact(state, () => {
			state.left.n = 5;
		});

		expect(state.left).toBe(state.right);
		expect(state.right.n).toBe(5);
		expect(heard[0]?.map((operation) => operation.do.path)).toEqual([
			["left", "n"],
			["right", "n"],
		]);
	});

	it("cycle", () => {
		const state = createMutableState<{ n: number; self?: object }>({ n: 1 });
		const heard = record(state);

		transact(state, () => {
			state.self = state;
		});

		expect(state.self).toBe(state);
		expect(heard[0]?.[0]?.do).toMatchObject({
			verb: "link",
			path: ["self"],
			ref: internedIdOf(requireHandle(state, "opshot: test requires a state"), state),
		});
	});

	it("move", () => {
		const state = createMutableState<{ from?: { n: number }; to?: { n: number } }>({ from: { n: 1 } });
		const held = state.from;
		const heard = record(state);

		transact(state, () => {
			state.to = state.from;
			delete state.from;
		});

		expect(state.to).toBe(held);
		expect(state.from).toBeUndefined();
		expect(heard[0]?.some((operation) => operation.do.verb === "delete")).toBe(true);
	});

	it("clone", () => {
		const state = createMutableState({ box: { a: 1 } });
		const heard = record(state);

		transact(state, () => {
			state.box.a = 2;
		});

		const cloned = cloneOperations(heard[0] ?? []);

		expect(cloned[0]?.do).toMatchObject({ verb: "assign", path: ["box", "a"], value: 2 });
	});

	it("apply", () => {
		const state = createMutableState({ box: { a: 1 } });
		const held = state.box;
		const heard = record(state);

		transact(state, () => {
			state.box = { a: 9 };
		});

		applyOperations(state, heard[0] ?? [], "undo");
		expect(isSameIdentity(state.box, held)).toBe(true);
		expect(state.box.a).toBe(1);

		applyOperations(state, heard[0] ?? [], "do");
		expect(state.box.a).toBe(9);
	});

	it("clone-apply", () => {
		const state = createMutableState({ box: { a: 1 } });
		const heard = record(state);

		transact(state, () => {
			state.box.a = 2;
		});

		const replica = createMutableState({ box: { a: 1 } });

		applyOperations(replica, cloneOperations(heard[0] ?? []), "do");
		expect(replica.box.a).toBe(2);
		expect(isSameIdentity(replica.box, state.box)).toBe(false);
	});

	it("rollback", () => {
		const state = createMutableState({ box: { a: 1 } });
		const held = state.box;
		const heard = record(state);

		expect(() =>
			transact(state, () => {
				state.box = { a: 9 };

				throw new Error("abort");
			}),
		).toThrow("abort");

		expect(isSameIdentity(state.box, held)).toBe(true);
		expect(heard).toEqual([]);
	});
});

describe("tracked array", () => {
	it("create", () => {
		const state = createMutableState({ list: [1, 2] });

		expect(isState(state)).toBe(true);
		expect(state.list).toEqual([1, 2]);
	});

	it("admit", () => {
		const state = createMutableState<{ list?: Array<number> }>({});

		transact(state, () => {
			state.list = [1, 2];
		});

		expect(state.list).toEqual([1, 2]);
	});

	it("in-place write", () => {
		const state = createMutableState({ list: [1, 2] });
		const heard = record(state);

		transact(state, () => {
			state.list[0] = 9;
		});

		expect(state.list[0]).toBe(9);
		expect(heard[0]?.[0]?.do).toMatchObject({ verb: "assign", path: ["list", 0], value: 9 });
	});

	it("replace", () => {
		const state = createMutableState({ list: [1, 2] });
		const heard = record(state);

		transact(state, () => {
			state.list = [9];
		});

		expect(state.list).toEqual([9]);
		expect(heard[0]?.[0]?.do).toMatchObject({ verb: "assign", path: ["list"] });
	});

	it("delete", () => {
		const state = createMutableState<{ list?: Array<number> }>({ list: [1, 2] });
		const heard = record(state);

		transact(state, () => {
			delete state.list;
		});

		expect(state.list).toBeUndefined();
		expect(heard[0]?.[0]?.do).toMatchObject({ verb: "delete", path: ["list"] });
	});

	it("alias", () => {
		const shared = [1, 2];
		const state = createMutableState({ left: shared, right: shared });
		const heard = record(state);

		transact(state, () => {
			state.left[0] = 9;
		});

		expect(state.left).toBe(state.right);
		expect(state.right[0]).toBe(9);
		expect(heard[0]?.map((operation) => operation.do.path)).toEqual([
			["left", 0],
			["right", 0],
		]);
	});

	it("cycle", () => {
		const state = createMutableState<{ list: Array<unknown> }>({ list: [] });
		const heard = record(state);

		transact(state, () => {
			state.list.push(state.list);
		});

		expect(state.list[0]).toBe(state.list);
		expect(heard[0]?.some((operation) => operation.do.verb === "link")).toBe(true);
	});

	it("move", () => {
		const state = createMutableState<{ from?: Array<number>; to?: Array<number> }>({ from: [1, 2] });
		const held = state.from;
		const heard = record(state);

		transact(state, () => {
			state.to = state.from;
			delete state.from;
		});

		expect(state.to).toBe(held);
		expect(state.from).toBeUndefined();
		expect(heard[0]?.[0]?.do.verb).toBeDefined();
	});

	it("clone", () => {
		const state = createMutableState({ list: [1, 2] });
		const heard = record(state);

		transact(state, () => {
			state.list[0] = 9;
		});

		const cloned = cloneOperations(heard[0] ?? []);

		expect(cloned[0]?.do).toMatchObject({ verb: "assign", path: ["list", 0], value: 9 });
	});

	it("apply", () => {
		const state = createMutableState({ list: [1, 2] });
		const held = state.list;
		const heard = record(state);

		transact(state, () => {
			state.list = [9];
		});

		applyOperations(state, heard[0] ?? [], "undo");
		expect(isSameIdentity(state.list, held)).toBe(true);

		applyOperations(state, heard[0] ?? [], "do");
		expect(state.list).toEqual([9]);
	});

	it("clone-apply", () => {
		const state = createMutableState({ list: [1, 2] });
		const heard = record(state);

		transact(state, () => {
			state.list[0] = 9;
		});

		const replica = createMutableState({ list: [1, 2] });

		applyOperations(replica, cloneOperations(heard[0] ?? []), "do");
		expect(replica.list[0]).toBe(9);
		expect(isSameIdentity(replica.list, state.list)).toBe(false);
	});

	it("rollback", () => {
		const state = createMutableState({ list: [1, 2] });
		const held = state.list;
		const heard = record(state);

		expect(() =>
			transact(state, () => {
				state.list = [9];

				throw new Error("abort");
			}),
		).toThrow("abort");

		expect(isSameIdentity(state.list, held)).toBe(true);
		expect(heard).toEqual([]);
	});
});

describe("ride-along", () => {
	it("create", () => {
		const marker = Symbol("ride");
		const state = createMutableState({ count: 0, [marker]: "initial" });

		expect(isState(state)).toBe(true);
		expect(state[marker]).toBe("initial");
	});

	it("admit", () => {
		const marker = Symbol("ride");
		const state = createMutableState<{ count: number; [marker]?: string }>({ count: 0 });

		transact(state, () => {
			state[marker] = "admitted";
		});

		expect(state[marker]).toBe("admitted");
	});

	it("in-place write", () => {
		const marker = Symbol("ride");
		const state = createMutableState({ count: 0, [marker]: "initial" });
		const heard = record(state);

		transact(state, () => {
			state[marker] = "written";
		});

		expect(state[marker]).toBe("written");
		expect(heard).toEqual([]);
	});

	it("rollback", () => {
		const marker = Symbol("ride");
		const state = createMutableState({ count: 0, [marker]: "initial" });
		const heard = record(state);

		expect(() =>
			transact(state, () => {
				state[marker] = "written";
				state.count = 1;

				throw new Error("abort");
			}),
		).toThrow("abort");

		expect(state.count).toBe(0);
		expect(state[marker]).toBe("written");
		expect(heard).toEqual([]);
	});
});

describe("frozen", () => {
	it("create", () => {
		const frozen = Object.freeze({ a: 1 });

		expect(createMutableState(frozen)).toBe(frozen);
		expect(isState(frozen)).toBe(false);
	});

	it("admit", () => {
		const frozen = Object.freeze({ a: 1 });
		const state = createMutableState<{ box?: { a: number } }>({});

		transact(state, () => {
			state.box = frozen;
		});

		expect(state.box).toBe(frozen);
	});

	it("in-place write", () => {
		const inner = { n: 1 };
		const frozen = Object.freeze({ inner });
		const state = createMutableState({ frozen, tick: 0 });
		const heard = record(state);

		transact(state, () => {
			state.frozen.inner.n = 2;
		});

		expect(inner.n).toBe(2);
		expect(heard).toEqual([]);
	});

	it("live freeze", () => {
		const inner = { n: 1 };
		const state = createMutableState({ box: { inner }, tick: 0 });
		const heard = record(state);

		Object.freeze(state.box);

		transact(state, () => {
			state.box.inner.n = 2;
			state.tick = 1;
		});

		expect(inner.n).toBe(2);
		expect(heard[0]?.map((operation) => operation.do.path)).toEqual([["tick"]]);
	});

	it("alias", () => {
		const inner = { n: 1 };
		const frozen = Object.freeze({ inner });
		const state = createMutableState({ left: frozen, right: frozen, tick: 0 });
		const heard = record(state);

		transact(state, () => {
			state.left.inner.n = 2;
			state.right.inner.n = 3;
			state.tick = 1;
		});

		expect(inner.n).toBe(3);
		expect(heard[0]?.map((operation) => operation.do.path)).toEqual([["tick"]]);
	});

	it("rollback", () => {
		const frozen = Object.freeze({ a: 1 });
		const state = createMutableState({ box: frozen, tick: 0 });
		const heard = record(state);

		expect(() =>
			transact(state, () => {
				state.tick = 1;

				throw new Error("abort");
			}),
		).toThrow("abort");

		expect(state.tick).toBe(0);
		expect(state.box).toBe(frozen);
		expect(heard).toEqual([]);
	});
});

describe("ignore()", () => {
	it("create", () => {
		const object = { a: 1 };

		expect(createMutableState(ignore(object))).toBe(object);
		expect(isState(object)).toBe(false);
	});

	it("admit", () => {
		const object = { a: 1 };
		const state = createMutableState({ box: ignore({ a: 0 }) });

		transact(state, () => {
			state.box = object;
		});

		expect(isSameIdentity(state.box, object)).toBe(true);
	});

	it("in-place write", () => {
		const object = { a: 1 };
		const state = createMutableState({ box: ignore(object), tick: 0 });
		const heard = record(state);

		transact(state, () => {
			state.box.a = 2;
		});

		expect(object.a).toBe(2);
		expect(heard).toEqual([]);
	});

	it("replace", () => {
		const first = { a: 1 };
		const second = { a: 2 };
		const state = createMutableState({ box: ignore(first), tick: 0 });
		const heard = record(state);

		transact(state, () => {
			state.box = second;
			state.tick = 1;
		});

		expect(isSameIdentity(state.box, second)).toBe(true);
		expect(heard[0]?.some((ops) => ops.do.path[0] === "box")).toBe(true);
	});

	it("delete", () => {
		const object = { a: 1 };
		const state = createMutableState({ box: ignore(object) as { a: number } | undefined, tick: 0 });
		const heard = record(state);

		transact(state, () => {
			delete state.box;
			state.tick = 1;
		});

		expect(state.box).toBeUndefined();
		expect(heard[0]?.some((operation) => operation.do.path[0] === "box")).toBe(true);
	});

	it("rollback", () => {
		const bag = { x: 0 };
		const state = createMutableState({ n: 0, bag: ignore(bag) });
		const heard = record(state);

		expect(() =>
			transact(state, () => {
				state.n = 1;
				state.bag.x = 99;

				throw new Error("abort");
			}),
		).toThrow("abort");

		expect(state.n).toBe(0);
		expect(bag.x).toBe(99);
		expect(heard).toEqual([]);
	});
});

describe("dangerous exotic", () => {
	it("create", () => {
		expect(() => createMutableState(new Map<string, number>())).toThrow();
	});

	it("admit", () => {
		const state = createMutableState<{ box?: Map<string, number> }>({});

		expect(() => {
			transact(state, () => {
				state.box = new Map();
			});
		}).toThrow();
		expect(state.box).toBeUndefined();
	});

	it("write", () => {
		const state = createMutableState<{ box?: Map<string, number> }>({});
		const heard = record(state);

		expect(() => {
			state.box = new Map();
		}).toThrow("Map at /box cannot be tracked");
		expect(heard).toEqual([]);
		expect(Object.hasOwn(state, "box")).toBe(false);
	});
});

describe("dangerous private", () => {
	it("create", () => {
		expect(() => createMutableState(new PrivateBox())).toThrow();
	});

	it("admit", () => {
		const state = createMutableState<{ box?: PrivateBox }>({});

		expect(() => {
			transact(state, () => {
				state.box = new PrivateBox();
			});
		}).toThrow();
		expect(state.box).toBeUndefined();
	});

	it("write", () => {
		const state = createMutableState<{ box?: PrivateBox }>({});
		const heard = record(state);

		expect(() => {
			state.box = new PrivateBox();
		}).toThrow("PrivateBox at /box cannot be tracked");
		expect(heard).toEqual([]);
		expect(Object.hasOwn(state, "box")).toBe(false);
	});
});

describe("dangerous own function on class", () => {
	it("create", () => {
		expect(() => createMutableState(new ArrowBox())).toThrow();
	});

	it("admit", () => {
		const state = createMutableState<{ box?: ArrowBox }>({});

		expect(() => {
			transact(state, () => {
				state.box = new ArrowBox();
			});
		}).toThrow();
		expect(state.box).toBeUndefined();
	});

	it("write", () => {
		const state = createMutableState<{ box?: ArrowBox }>({});
		const heard = record(state);

		expect(() => {
			state.box = new ArrowBox();
		}).toThrow("ArrowBox at /box/bump cannot be tracked");
		expect(heard).toEqual([]);
		expect(Object.hasOwn(state, "box")).toBe(false);
	});
});

describe("dangerous non-writable object property", () => {
	it("create", () => {
		expect(() => createMutableState({ box: nonWritableObjectCarrier() })).toThrow();
	});

	it("admit", () => {
		const state = createMutableState<{ box?: object }>({});

		expect(() => {
			transact(state, () => {
				state.box = nonWritableObjectCarrier();
			});
		}).toThrow();
		expect(state.box).toBeUndefined();
	});

	it("write", () => {
		const state = createMutableState<{ box?: object }>({});
		const heard = record(state);

		expect(() => {
			state.box = nonWritableObjectCarrier();
		}).toThrow("at /box/outer cannot be tracked");
		expect(heard).toEqual([]);
		expect(Object.hasOwn(state, "box")).toBe(false);
	});
});

describe("unsafeTrack() of dangerous", () => {
	it("create", () => {
		const state = createMutableState(unsafeTrack(new Map<string, number>()));

		expect(isState(state)).toBe(true);
		expect(state).toBeInstanceOf(Map);
	});

	it("admit", () => {
		const map = new Map<string, number>();
		const state = createMutableState({
			box: unsafeTrack(new Map<string, number>()),
		});

		transact(state, () => {
			state.box = unsafeTrack(map);
		});

		expect(state.box !== undefined && isSameIdentity(state.box, map)).toBe(true);
	});

	it("replace", () => {
		const first = new Map<string, number>([["a", 1]]);
		const second = new Map<string, number>([["b", 2]]);
		const state = createMutableState({ box: unsafeTrack(first) });
		const heard = record(state);

		transact(state, () => {
			state.box = unsafeTrack(second);
		});

		expect(isSameIdentity(state.box, second)).toBe(true);
		expect(heard[0]?.[0]?.do).toMatchObject({ verb: "assign", path: ["box"] });
	});

	it("delete", () => {
		const map = new Map<string, number>();
		const state = createMutableState({
			box: unsafeTrack(map) as Map<string, number> | undefined,
		});
		const heard = record(state);

		transact(state, () => {
			delete state.box;
		});

		expect(state.box).toBeUndefined();
		expect(heard[0]?.[0]?.do).toMatchObject({ verb: "delete", path: ["box"] });
	});

	it("rollback", () => {
		const map = new Map<string, number>([["a", 1]]);
		const state = createMutableState({ box: unsafeTrack(map) });
		const held = state.box;
		const heard = record(state);

		expect(() =>
			transact(state, () => {
				state.box = unsafeTrack(new Map([["b", 2]]));

				throw new Error("abort");
			}),
		).toThrow("abort");

		expect(isSameIdentity(state.box, held)).toBe(true);
		expect(heard).toEqual([]);
	});
});

describe("strict: false dangerous", () => {
	it("create", () => {
		const state = createMutableState(new Map<string, number>(), { strict: false });

		expect(isState(state)).toBe(true);
		expect(state).toBeInstanceOf(Map);
	});

	it("admit", () => {
		const map = new Map<string, number>();
		const state = createMutableState<{ box?: Map<string, number> }>({}, { strict: false });

		transact(state, () => {
			state.box = map;
		});

		expect(state.box !== undefined && isSameIdentity(state.box, map)).toBe(true);
	});

	it("rollback", () => {
		const map = new Map<string, number>([["a", 1]]);
		const state = createMutableState<{ box: Map<string, number> }>({ box: map }, { strict: false });
		const held = state.box;
		const heard = record(state);

		expect(() =>
			transact(state, () => {
				state.box = new Map([["b", 2]]);

				throw new Error("abort");
			}),
		).toThrow("abort");

		expect(isSameIdentity(state.box, held)).toBe(true);
		expect(heard).toEqual([]);
	});
});
