import { transact } from "./transact/transact";
import { createMutableState } from "./createMutableState";
import { edgeStatusOf, slotStatusOf } from "./edges";
import { handleOf } from "./handle";
import { isSameIdentity } from "./identity";
import { unsafeMarker, unsafeTrack } from "./unsafeTrack";

describe("unsafeTrack occupancy", () => {
	it("keeps a create-time unsafe path admitted across reassignment", () => {
		const first = new Map<string, number>([["a", 1]]);
		const second = new Map<string, number>([["b", 2]]);
		const state = createMutableState({ foo: unsafeTrack(first) });

		transact(state, () => {
			state.foo = second;
		});

		expect(isSameIdentity(state.foo, second)).toBe(true);
	});

	it("admits a dangerous value nested under an unsafe boundary", () => {
		const nested = new Map<string, number>([["k", 1]]);
		const state = createMutableState({ box: unsafeTrack({ nested }) });

		expect(isSameIdentity(state.box.nested, nested)).toBe(true);

		const next = new Map<string, number>([["k", 2]]);

		transact(state, () => {
			state.box.nested = next;
		});

		expect(isSameIdentity(state.box.nested, next)).toBe(true);
	});

	it("throws at the cause when a dangerous value sits outside an unsafe boundary", () => {
		expect(() => createMutableState({ safe: unsafeTrack({ n: 1 }), map: new Map<string, number>() })).toThrow(
			"Map at /map cannot be tracked",
		);
	});

	it("does not copy an unsafe parent edge onto a sibling occupancy of the same node", () => {
		const holder: { nested: object } = { nested: { n: 1 } };
		const state = createMutableState({ a: unsafeTrack(holder), b: holder });

		expect(() => {
			transact(state, () => {
				state.b.nested = new Map<string, number>();
			});
		}).toThrow("cannot be tracked");
	});

	it("admits a nested unsafeTrack under every occupancy of a shared node", () => {
		const holder: { nested: object } = { nested: unsafeTrack({ n: 1 }) };
		const state = createMutableState({ a: holder, b: holder });

		transact(state, () => {
			state.a.nested = new Map<string, number>([["a", 1]]);
		});

		transact(state, () => {
			state.b.nested = new Map<string, number>([["b", 2]]);
		});

		expect(state.a.nested).toBeInstanceOf(Map);
		expect(state.b.nested).toBeInstanceOf(Map);
	});

	it("marks both edges when the same unsafe wrapper occupies two paths", () => {
		const holder: { nested: object } = { nested: { n: 1 } };
		const marked = unsafeTrack(holder);
		const state = createMutableState({ a: marked, b: marked });

		transact(state, () => {
			state.a.nested = new Map<string, number>([["a", 1]]);
		});

		transact(state, () => {
			state.b.nested = new Map<string, number>([["b", 2]]);
		});

		expect(state.a.nested).toBeInstanceOf(Map);
		expect(state.b.nested).toBeInstanceOf(Map);
	});

	it("admits a dangerous assign when any occupancy of the last edge is unsafe and still throws on a strict occupancy", () => {
		const holder: { nested: object } = { nested: { n: 1 } };
		const state = createMutableState({ a: unsafeTrack(holder), b: holder });

		expect(() => {
			transact(state, () => {
				state.b.nested = new Map<string, number>();
			});
		}).toThrow("cannot be tracked");

		expect(state.b.nested).toEqual({ n: 1 });
		expect(state.a.nested).toEqual({ n: 1 });
	});

	it("lands a live unsafeTrack() assignment as a ride-along-bearing object", () => {
		const map = new Map<string, number>();
		const state = createMutableState<{ foo: unknown }>({ foo: null });

		transact(state, () => {
			state.foo = unsafeTrack(map);
		});

		expect(state.foo).not.toBe(map);
		expect(typeof state.foo === "object" && state.foo !== null && Object.hasOwn(state.foo, unsafeMarker)).toBe(true);
	});

	it("admits dangerous material through a node whose every grounded chain is unsafe", () => {
		const holder: { nested: object } = { nested: { n: 1 } };
		const state = createMutableState({ a: unsafeTrack(holder) });

		transact(state, () => {
			state.a.nested = new Map<string, number>([["k", 1]]);
		});

		expect(state.a.nested).toBeInstanceOf(Map);
	});

	it("refuses dangerous material through a node that has a clean grounded chain", () => {
		const holder: { nested: object } = { nested: { n: 1 } };
		const state = createMutableState({ a: unsafeTrack(holder), b: holder });

		expect(() => {
			transact(state, () => {
				state.a.nested = new Map<string, number>();
			});
		}).toThrow("cannot be tracked");

		expect(state.a.nested).toEqual({ n: 1 });
		expect(state.b.nested).toEqual({ n: 1 });
	});

	it("refuses a Map assigned below a declared unsafeTrack when a runtime alias holds a clean chain", () => {
		const state = createMutableState(
			{ a: { x: { y: unsafeTrack({ n: 1 }) } }, b: 0 } as unknown as {
				a: { x: { y: object } };
				b: { x: { y: object } } | number;
			},
			{ strict: true },
		);

		transact(state, () => {
			state.b = state.a;
		});

		expect(() => {
			transact(state, () => {
				state.a.x = { y: new Map() };
			});
		}).toThrow("cannot be tracked");
	});

	it("keeps the clean chain of an aliased unsafe parent under a back-pointer cycle", () => {
		const state = createMutableState(
			{ c: { k1: unsafeTrack({}), w: {} } } as unknown as {
				c: { k1: { m?: object }; w: { z?: object; k2?: object } };
			},
			{ strict: true },
		);
		const handle = handleOf(state);

		expect(handle).toBeDefined();

		state.c.w.z = state.c;
		state.c.w.k2 = state.c.k1;

		expect(slotStatusOf(handle!, state.c.k1, "m").unsafe).toBe(false);
		expect(edgeStatusOf(handle!, state.c.k1).unsafe).toBe(false);

		expect(() => {
			transact(state, () => {
				state.c.k1.m = new Map();
			});
		}).toThrow("cannot be tracked");
	});
});
