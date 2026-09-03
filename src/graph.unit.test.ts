import { createMutableState } from "./createMutableState";
import { ignore } from "./ignore";
import { isState } from "./isState";
import type { Operation } from "./operation";
import { subscribe } from "./subscribe";
import { unsafeTrack } from "./unsafeTrack";

const listen = (state: object): Array<ReadonlyArray<Operation>> => {
	const heard: Array<ReadonlyArray<Operation>> = [];

	subscribe(state, (operations) => {
		heard.push(operations);
	});

	return heard;
};

describe("createMutableState with a non-object", () => {
	it("a primitive is returned unchanged", () => {
		expect(createMutableState(1 as never)).toBe(1);
	});
});

describe("§1.1 ride-alongs are untracked edges", () => {
	it("a symbol key produces no operation", async () => {
		const key = Symbol("hidden");
		const state = createMutableState({ n: 0 } as { n: number; [symbol: symbol]: number });
		const heard = listen(state);

		state[key] = 1;

		await Promise.resolve();

		expect(heard).toEqual([]);
		expect(state[key]).toBe(1);
	});

	it("a non-enumerable property is an untracked edge", async () => {
		const child = { n: 1 };
		const raw = { visible: 0 };

		Object.defineProperty(raw, "hidden", { value: child, enumerable: false, writable: true, configurable: true });

		const state = createMutableState(raw) as { visible: number; hidden: { n: number } };
		const heard = listen(state);

		state.hidden.n = 2;

		await Promise.resolve();

		expect(heard).toEqual([]);
		expect(state.hidden).toBe(child);
		expect(child.n).toBe(2);
	});

	it("an accessor produces no operation", async () => {
		let stored = 0;
		const raw: { n: number; count?: number } = { n: 0 };

		Object.defineProperty(raw, "count", {
			get: () => stored,
			set: (value: number) => {
				stored = value;
			},
			enumerable: true,
		});

		const state = createMutableState(raw);
		const heard = listen(state);

		state.count = 1;

		await Promise.resolve();

		expect(heard).toEqual([]);
		expect(stored).toBe(1);
		expect(state.count).toBe(1);
	});

	it("an own __proto__ property is an untracked edge", async () => {
		const child = { n: 1 };
		const raw: { n: number } = { n: 0 };

		Object.defineProperty(raw, "__proto__", { value: child, enumerable: true, writable: true, configurable: true });

		const state = createMutableState(raw) as { n: number } & Record<"__proto__", { n: number }>;
		const heard = listen(state);

		state["__proto__"] = { n: 3 };

		await Promise.resolve();

		expect(heard).toEqual([]);
	});
});

describe("§1.2 freezing makes every edge to a node untracked", () => {
	it("a child frozen before assignment reads raw and its interior write produces none", async () => {
		const inner = { x: 1 };
		const child = Object.freeze({ inner });
		const state = createMutableState({ child });
		const heard = listen(state);

		expect(state.child).toBe(child);

		state.child.inner.x = 2;

		await Promise.resolve();

		expect(heard).toEqual([]);
		expect(inner.x).toBe(2);
	});

	it("a child frozen through the proxy after assignment produces none on a later interior write", async () => {
		const state = createMutableState({ child: { inner: { x: 1 } } });
		const heard = listen(state);

		Object.freeze(state.child);
		state.child.inner.x = 2;

		await Promise.resolve();

		expect(heard).toEqual([]);
		expect(state.child.inner.x).toBe(2);
	});

	it("a frozen object holding an object assigns into a strict state as an untracked edge", async () => {
		const state = createMutableState({ x: undefined as { a: { n: number } } | undefined });
		const heard = listen(state);
		const frozen = Object.freeze({ a: { n: 1 } });

		state.x = frozen;

		await Promise.resolve();

		expect(heard).toHaveLength(1);
		expect(heard[0]?.[0]?.key).toBe("x");

		const readBack = state.x;

		if (readBack === undefined) throw new Error("missing child");

		expect(readBack).toBe(frozen);

		heard.length = 0;

		readBack.a.n = 2;

		await Promise.resolve();

		expect(heard).toEqual([]);
	});
});

describe("§1.3 a node with no route of tracked edges from a root is untracked", () => {
	it("a node deleted from its only route produces no operation on a later write through a held proxy", async () => {
		const state = createMutableState({ a: { n: 1 } } as { a?: { n: number } });
		const held = state.a;

		if (held === undefined) throw new Error("missing child");

		delete state.a;

		await Promise.resolve();

		const heard = listen(state);

		held.n = 2;

		await Promise.resolve();

		expect(heard).toEqual([]);
		expect(held.n).toBe(2);
	});

	it("a self-assign then delete leaves the node untracked", async () => {
		const state = createMutableState({ a: { n: 1 } } as { a?: { n: number } });
		const held = state.a;

		if (held === undefined) throw new Error("missing child");

		state.a = held;
		delete state.a;

		await Promise.resolve();

		const heard = listen(state);

		held.n = 2;

		await Promise.resolve();

		expect(heard).toEqual([]);
	});

	it("re-aliasing an already-shared child does not keep it after every route is deleted", async () => {
		const child = { n: 1 };
		const state = createMutableState({ a: child, b: child } as { a?: { n: number }; b?: { n: number } });
		const held = state.a;

		if (held === undefined) throw new Error("missing child");

		state.b = state.a;
		delete state.a;
		delete state.b;

		await Promise.resolve();

		const heard = listen(state);

		held.n = 2;

		await Promise.resolve();

		expect(heard).toEqual([]);
	});
});

describe("§1.4 an edge is dangerous and untracked when it is", () => {
	it("an exotic hidden store is untracked in a strict state, under strict: false, and beneath unsafeTrack", async () => {
		const mapForStrict = new Map<string, number>();
		const mapForLoose = new Map<string, number>();
		const mapForMarked = new Map<string, number>();
		const strictState = createMutableState({ holder: { nested: unsafeTrack(mapForStrict), label: 0 } });
		const looseState = createMutableState({ holder: { nested: mapForLoose, label: 0 } }, { strict: false });
		const markedState = createMutableState({ holder: unsafeTrack({ nested: mapForMarked, label: 0 }) });
		const strictHeard = listen(strictState);
		const looseHeard = listen(looseState);
		const markedHeard = listen(markedState);

		mapForStrict.set("a", 1);
		mapForLoose.set("a", 1);
		mapForMarked.set("a", 1);

		await Promise.resolve();

		expect(strictHeard).toEqual([]);
		expect(looseHeard).toEqual([]);
		expect(markedHeard).toEqual([]);

		strictState.holder.label = 1;
		looseState.holder.label = 1;
		markedState.holder.label = 1;

		await Promise.resolve();

		expect(strictHeard[0]?.map((operation) => operation.key)).toEqual(["label"]);
		expect(looseHeard[0]?.map((operation) => operation.key)).toEqual(["label"]);
		expect(markedHeard[0]?.map((operation) => operation.key)).toEqual(["label"]);
	});

	it("a private field is untracked in a strict state, under strict: false, and beneath unsafeTrack", async () => {
		class Vault {
			#secret = 1;
			visible = 0;

			write(value: number): void {
				this.#secret = value;
			}

			read(): number {
				return this.#secret;
			}
		}

		const strictVault = new Vault();
		const looseVault = new Vault();
		const markedVault = new Vault();
		const strictState = createMutableState({ holder: unsafeTrack(strictVault) });
		const looseState = createMutableState({ holder: looseVault }, { strict: false });
		const markedState = createMutableState({ holder: unsafeTrack(markedVault) });
		const strictHeard = listen(strictState);
		const looseHeard = listen(looseState);
		const markedHeard = listen(markedState);

		strictVault.write(2);
		looseVault.write(2);
		markedVault.write(2);

		expect(strictVault.read()).toBe(2);
		expect(looseVault.read()).toBe(2);
		expect(markedVault.read()).toBe(2);

		await Promise.resolve();

		expect(strictHeard).toEqual([]);
		expect(looseHeard).toEqual([]);
		expect(markedHeard).toEqual([]);

		strictState.holder.visible = 1;
		looseState.holder.visible = 1;
		markedState.holder.visible = 1;

		await Promise.resolve();

		expect(strictHeard[0]?.map((operation) => operation.key)).toEqual(["visible"]);
		expect(looseHeard[0]?.map((operation) => operation.key)).toEqual(["visible"]);
		expect(markedHeard[0]?.map((operation) => operation.key)).toEqual(["visible"]);
	});

	it("an own function property on a class instance is untracked in a strict state, under strict: false, and beneath unsafeTrack", async () => {
		class Box {
			label = 0;
			method = (): number => 1;
		}

		const strictState = createMutableState({ holder: unsafeTrack(new Box()) });
		const looseState = createMutableState({ holder: new Box() }, { strict: false });
		const markedState = createMutableState({ holder: unsafeTrack(new Box()) });
		const strictHeard = listen(strictState);
		const looseHeard = listen(looseState);
		const markedHeard = listen(markedState);

		strictState.holder.method();
		looseState.holder.method();
		markedState.holder.method();

		await Promise.resolve();

		expect(strictHeard).toEqual([]);
		expect(looseHeard).toEqual([]);
		expect(markedHeard).toEqual([]);
		expect(isState(strictState.holder.method)).toBe(false);
		expect(isState(looseState.holder.method)).toBe(false);
		expect(isState(markedState.holder.method)).toBe(false);

		strictState.holder.label = 1;
		looseState.holder.label = 1;
		markedState.holder.label = 1;

		await Promise.resolve();

		expect(strictHeard[0]?.map((operation) => operation.key)).toEqual(["label"]);
		expect(looseHeard[0]?.map((operation) => operation.key)).toEqual(["label"]);
		expect(markedHeard[0]?.map((operation) => operation.key)).toEqual(["label"]);
	});

	it("a non-writable property holding an object is untracked in a strict state, under strict: false, and beneath unsafeTrack", async () => {
		const lock = (inner: { n: number }): { inner: { n: number }; label: number } => {
			const holder = { inner, label: 0 };

			Object.defineProperty(holder, "inner", {
				value: inner,
				writable: false,
				enumerable: true,
				configurable: true,
			});

			return holder;
		};

		const strictInner = { n: 1 };
		const looseInner = { n: 1 };
		const markedInner = { n: 1 };
		const strictState = createMutableState({ holder: unsafeTrack(lock(strictInner)) });
		const looseState = createMutableState({ holder: lock(looseInner) }, { strict: false });
		const markedState = createMutableState({ holder: unsafeTrack(lock(markedInner)) });
		const strictHeard = listen(strictState);
		const looseHeard = listen(looseState);
		const markedHeard = listen(markedState);

		strictState.holder.inner.n = 2;
		looseState.holder.inner.n = 2;
		markedState.holder.inner.n = 2;

		await Promise.resolve();

		expect(strictHeard).toEqual([]);
		expect(looseHeard).toEqual([]);
		expect(markedHeard).toEqual([]);

		strictState.holder.label = 1;
		looseState.holder.label = 1;
		markedState.holder.label = 1;

		await Promise.resolve();

		expect(strictHeard[0]?.map((operation) => operation.key)).toEqual(["label"]);
		expect(looseHeard[0]?.map((operation) => operation.key)).toEqual(["label"]);
		expect(markedHeard[0]?.map((operation) => operation.key)).toEqual(["label"]);
	});
});

describe("§1.6 ignore() marks an object; every edge to an ignored object is untracked in every state", () => {
	it("ignore before admission leaves the object raw and silent on interior writes", async () => {
		const child = { n: 1 };
		const state = createMutableState({ child: ignore(child) });
		const heard = listen(state);

		expect(state.child).toBe(child);

		state.child.n = 2;

		await Promise.resolve();

		expect(heard).toEqual([]);
		expect(child.n).toBe(2);
	});

	it("an ignored object holding a dangerous edge assigns into a strict state without a throw", async () => {
		const state = createMutableState({ x: undefined as object | undefined });
		const heard = listen(state);
		const marked = ignore({ inner: new Map<string, number>() });

		state.x = marked;

		await Promise.resolve();

		expect(state.x).toBe(marked);
		expect(heard).toHaveLength(1);
		expect(heard[0]?.[0]?.key).toBe("x");
	});
});

describe("§1.7 marking or clearing an object changes no existing edge", () => {
	it("ignore after admission leaves the existing edge tracked", async () => {
		const state = createMutableState({ child: { n: 1 } });
		const heard = listen(state);

		ignore(state.child);
		state.child.n = 2;

		await Promise.resolve();

		expect(heard).toHaveLength(1);
		expect(heard[0]?.[0]?.key).toBe("n");
		expect(heard[0]?.[0]?.after).toBe(2);
	});

	it("a node ignored after admission detaches when its edge is deleted", async () => {
		const state = createMutableState({ inner: { v: 0 } } as { inner?: { v: number } });
		const held = state.inner;

		if (held === undefined) throw new Error("missing child");

		ignore(held);

		delete state.inner;

		await Promise.resolve();

		const heard = listen(state);

		held.v = 1;

		await Promise.resolve();

		expect(heard).toEqual([]);
	});
});

describe("§1.9 a state observes assignment and deletion made through it", () => {
	it("assignment and deletion through the state emit, and a write through the raw object is user-owned", async () => {
		const raw: { count: number; extra?: number } = { count: 0, extra: 1 };
		const state = createMutableState(raw);
		const heard = listen(state);

		raw.count = 8;

		await Promise.resolve();

		expect(heard).toEqual([]);
		expect(state.count).toBe(8);

		state.count = 1;
		delete state.extra;

		await Promise.resolve();

		expect(heard).toHaveLength(1);
		expect(heard[0]?.map((operation) => operation.key)).toEqual(["count", "extra"]);
		expect(heard[0]?.[0]).toMatchObject({ key: "count", before: 8, after: 1 });
		expect("after" in (heard[0]?.[1] ?? {})).toBe(false);
		expect(heard[0]?.[1]?.before).toBe(1);
	});
});

describe("§2.1 a tracked node's reads reflect its writes immediately", () => {
	it("a write is visible on the next read before emission", async () => {
		const state = createMutableState({ count: 0 });
		const heard = listen(state);

		state.count = 1;

		expect(state.count).toBe(1);
		expect(heard).toEqual([]);

		await Promise.resolve();

		expect(heard).toHaveLength(1);
	});
});

describe("§2.2 assigning a node into a state it currently occupies keeps its identity in that state", () => {
	it("state.b = state.a gives state.a === state.b", () => {
		const state = createMutableState({ a: { n: 1 }, b: { n: 2 } });

		state.b = state.a;

		expect(state.a).toBe(state.b);
		expect(state.a.n).toBe(1);
	});

	it("an aliased node keeps producing after one route is deleted", async () => {
		const child = { n: 1 };
		const state = createMutableState({ a: child, b: child } as { a?: { n: number }; b: { n: number } });
		const held = state.b;

		delete state.a;

		await Promise.resolve();

		const heard = listen(state);

		held.n = 2;

		await Promise.resolve();

		expect(state.b).toBe(held);
		expect(heard).toHaveLength(1);
		expect(heard[0]?.[0]?.node).toBe(held);
		expect(heard[0]?.[0]?.key).toBe("n");
		expect(heard[0]?.[0]?.after).toBe(2);
	});

	it("aliasing a member keeps its children at one edge each", async () => {
		const child = { grand: { n: 1 } };
		const state = createMutableState({ a: child, b: undefined } as {
			a?: { grand: { n: number } };
			b?: { grand: { n: number } };
		});

		state.b = state.a;

		delete state.a;

		await Promise.resolve();

		const heard = listen(state);
		const branch = state.b;

		if (branch === undefined) throw new Error("missing child");

		branch.grand.n = 2;

		await Promise.resolve();

		expect(heard).toHaveLength(1);
		expect(heard[0]?.[0]?.key).toBe("n");

		const held = branch.grand;

		delete state.b;

		await Promise.resolve();

		heard.length = 0;

		held.n = 3;

		await Promise.resolve();

		expect(heard).toEqual([]);
	});
});
