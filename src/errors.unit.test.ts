import { createMutableState } from "./createMutableState";
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

class Vault {
	#secret = 1;
	visible = 0;

	read(): number {
		return this.#secret;
	}
}

class Box {
	label = 0;
	method = (): number => 1;
}

describe("§7.1 strict: true throws at a dangerous edge, at the cause", () => {
	it("throws at an exotic hidden store and names the route", () => {
		expect(() => createMutableState({ a: { b: new Map() } })).toThrow("Map at /a/b cannot be tracked");
	});

	it("throws at a private field and names the route", () => {
		const vault = new Vault();

		expect(vault.read()).toBe(1);
		expect(() => createMutableState({ vault })).toThrow("Vault at /vault cannot be tracked");
	});

	it("throws at an own function property on a class instance and names the route", () => {
		expect(() => createMutableState({ box: new Box() })).toThrow("Box at /box/method cannot be tracked");
	});

	it("throws at a non-writable property holding an object and names the route", () => {
		const inner = { n: 1 };
		const holder: { inner: { n: number } } = { inner };

		Object.defineProperty(holder, "inner", {
			value: inner,
			writable: false,
			enumerable: true,
			configurable: true,
		});

		expect(() => createMutableState({ holder })).toThrow("Object at /holder/inner cannot be tracked");
	});

	it("a throwing assignment leaves the state unchanged", () => {
		const state = createMutableState({ foo: { n: 1 } as object });

		expect(() => {
			state.foo = new Map();
		}).toThrow("Map at /foo cannot be tracked");

		expect(state.foo).toEqual({ n: 1 });
	});

	it("a throwing assignment rolls back the edges it attached before the throw", async () => {
		const state = createMutableState({ keep: { n: 0 }, x: undefined } as {
			keep?: { n: number };
			x?: object;
		});
		const keep = state.keep;

		if (keep === undefined) throw new Error("missing child");

		expect(() => {
			state.x = { also: keep, bad: new Map() };
		}).toThrow("Map at /x/bad cannot be tracked");

		const heard = listen(state);

		keep.n = 1;

		await Promise.resolve();

		expect(heard).toHaveLength(1);

		delete state.keep;

		await Promise.resolve();

		heard.length = 0;

		keep.n = 2;

		await Promise.resolve();

		expect(heard).toEqual([]);
	});

	it("a throwing assignment undoes the partial attach beneath it", async () => {
		const state = createMutableState({ x: undefined } as { x?: { deep: { n: number } } });
		const fine = { deep: { n: 0 } };

		expect(() => {
			state.x = { fine, bad: new Map() } as unknown as { deep: { n: number } };
		}).toThrow("Map at /x/bad cannot be tracked");

		state.x = fine;

		const attached = state.x;

		if (attached === undefined) throw new Error("missing child");

		const held = attached.deep;

		delete state.x;

		await Promise.resolve();

		const heard = listen(state);

		held.n = 1;

		await Promise.resolve();

		expect(heard).toEqual([]);
	});

	it("a write the target refuses attaches no edge", async () => {
		const raw = { keep: { n: 0 }, locked: 0 };

		Object.defineProperty(raw, "locked", { value: 0, writable: false, enumerable: true, configurable: true });

		const state = createMutableState(raw as { keep?: { n: number }; locked: unknown });
		const keep = state.keep;

		if (keep === undefined) throw new Error("missing child");

		expect(() => {
			state.locked = keep;
		}).toThrow(TypeError);

		delete state.keep;

		await Promise.resolve();

		const heard = listen(state);

		keep.n = 1;

		await Promise.resolve();

		expect(heard).toEqual([]);
	});

	it("a throwing creation leaves no membership behind", () => {
		const raw = { ok: {}, bad: new Map() };

		expect(() => createMutableState(raw)).toThrow("Map at /bad cannot be tracked");
		expect(() => createMutableState(raw)).toThrow("Map at /bad cannot be tracked");
	});
});

describe("§7.2 a node entering a state while marked, or entering beneath an exempt node, is exempt from §7.1", () => {
	it("admits a marked node that would otherwise throw", () => {
		const state = createMutableState({ box: unsafeTrack(new Map<string, number>([["k", 1]])) });

		expect(state.box).toBeInstanceOf(Map);
	});

	it("admits a node beneath a marked node", () => {
		const nested = new Map<string, number>([["k", 1]]);
		const state = createMutableState({ box: unsafeTrack({ inner: { nested } }) });

		expect(state.box.inner.nested).toBeInstanceOf(Map);
	});

	it("a throwing assignment of an unmarked replacement leaves the state unchanged", () => {
		const first = new Map<string, number>([["a", 1]]);
		const state = createMutableState({ foo: unsafeTrack(first) as Map<string, number> });

		expect(() => {
			state.foo = new Map([["b", 2]]);
		}).toThrow("cannot be tracked");

		expect(state.foo).toBeInstanceOf(Map);
		expect(first.get("a")).toBe(1);
		expect(first.size).toBe(1);
	});
});
