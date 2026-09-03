import { batch } from "./batch";
import { createMutableState } from "./createMutableState";
import { handleOf } from "./handle";
import { isSameIdentity } from "./identity";
import { isUnsafeMarked, unsafeTrack } from "./unsafeTrack";

describe("§7.2 unsafeTrack occupancy", () => {
	it("throws when an unmarked replacement enters a slot whose previous occupant was unsafe-marked", () => {
		const first = new Map<string, number>([["a", 1]]);
		const second = new Map<string, number>([["b", 2]]);
		const state = createMutableState({ foo: unsafeTrack(first) });

		expect(() => {
			batch(() => {
				state.foo = second;
			});
		}).toThrow("cannot be tracked");

		expect(isSameIdentity(state.foo, first)).toBe(true);
	});

	it("admits a dangerous value nested under an unsafe boundary", () => {
		const nested = new Map<string, number>([["k", 1]]);
		const state = createMutableState({ box: unsafeTrack({ nested }) });

		expect(isSameIdentity(state.box.nested, nested)).toBe(true);

		const next = new Map<string, number>([["k", 2]]);

		batch(() => {
			state.box.nested = next;
		});

		expect(isSameIdentity(state.box.nested, next)).toBe(true);
	});

	it("throws at the cause when a dangerous value sits outside an unsafe boundary", () => {
		expect(() => createMutableState({ safe: unsafeTrack({ n: 1 }), map: new Map<string, number>() })).toThrow(
			"Map at /map cannot be tracked",
		);
	});

	it("admits dangerous material at every occupancy of a node that entered while unsafe-marked", () => {
		const holder: { nested: object } = { nested: { n: 1 } };
		const state = createMutableState({ a: unsafeTrack(holder), b: holder });

		batch(() => {
			state.b.nested = new Map<string, number>();
		});

		expect(state.b.nested).toBeInstanceOf(Map);
	});

	it("admits a nested unsafeTrack under every occupancy of a shared node", () => {
		const holder: { nested: object } = { nested: unsafeTrack({ n: 1 }) };
		const state = createMutableState({ a: holder, b: holder });

		batch(() => {
			state.a.nested = unsafeTrack(new Map<string, number>([["a", 1]]));
		});

		batch(() => {
			state.b.nested = unsafeTrack(new Map<string, number>([["b", 2]]));
		});

		expect(state.a.nested).toBeInstanceOf(Map);
		expect(state.b.nested).toBeInstanceOf(Map);
	});

	it("marks both edges when the same unsafe wrapper occupies two paths", () => {
		const holder: { nested: object } = { nested: { n: 1 } };
		const marked = unsafeTrack(holder);
		const state = createMutableState({ a: marked, b: marked });

		batch(() => {
			state.a.nested = new Map<string, number>([["a", 1]]);
		});

		batch(() => {
			state.b.nested = new Map<string, number>([["b", 2]]);
		});

		expect(state.a.nested).toBeInstanceOf(Map);
		expect(state.b.nested).toBeInstanceOf(Map);
	});

	it("admits a dangerous assign through every occupancy of a node that entered while unsafe-marked", () => {
		const holder: { nested: object } = { nested: { n: 1 } };
		const state = createMutableState({ a: unsafeTrack(holder), b: holder });

		batch(() => {
			state.b.nested = new Map<string, number>();
		});

		expect(state.b.nested).toBeInstanceOf(Map);
		expect(state.a.nested).toBe(state.b.nested);
	});

	it("lands a live unsafeTrack() assignment as the marked object", () => {
		const map = new Map<string, number>();
		const state = createMutableState<{ foo: unknown }>({ foo: null });

		batch(() => {
			state.foo = unsafeTrack(map);
		});

		expect(typeof state.foo === "object" && state.foo !== null && isSameIdentity(state.foo, map)).toBe(true);
		expect(isUnsafeMarked(map)).toBe(true);
	});

	it("admits dangerous material through a node whose every grounded chain is unsafe", () => {
		const holder: { nested: object } = { nested: { n: 1 } };
		const state = createMutableState({ a: unsafeTrack(holder) });

		batch(() => {
			state.a.nested = new Map<string, number>([["k", 1]]);
		});

		expect(state.a.nested).toBeInstanceOf(Map);
	});

	it("admits dangerous material through a node that entered while unsafe-marked even when another occupancy is unmarked", () => {
		const holder: { nested: object } = { nested: { n: 1 } };
		const state = createMutableState({ a: unsafeTrack(holder), b: holder });

		batch(() => {
			state.a.nested = new Map<string, number>();
		});

		expect(state.a.nested).toBeInstanceOf(Map);
		expect(state.b.nested).toBe(state.a.nested);
	});

	it("refuses a Map assigned below a declared unsafeTrack when a runtime alias holds a clean chain", () => {
		const state = createMutableState(
			{ a: { x: { y: unsafeTrack({ n: 1 }) } }, b: 0 } as unknown as {
				a: { x: { y: object } };
				b: { x: { y: object } } | number;
			},
			{ strict: true },
		);

		batch(() => {
			state.b = state.a;
		});

		expect(() => {
			batch(() => {
				state.a.x = { y: new Map() };
			});
		}).toThrow("cannot be tracked");
	});

	it("admits dangerous material at an unsafe-marked node after a back-pointer cycle aliases it", () => {
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

		batch(() => {
			state.c.k1.m = new Map();
		});

		expect(state.c.k1.m).toBeInstanceOf(Map);
	});

	it("admits dangerous material at and beneath a node that entered while unsafe-marked", () => {
		const nested = new Map<string, number>([["k", 1]]);
		const box = { nested };

		unsafeTrack(box);

		const state = createMutableState({ box });

		expect(isSameIdentity(state.box.nested, nested)).toBe(true);

		const next = new Map<string, number>([["k", 2]]);

		batch(() => {
			state.box.nested = next;
		});

		expect(isSameIdentity(state.box.nested, next)).toBe(true);
	});

	it("inherits exemption onto a node that enters beneath an exempt node", () => {
		const child = { held: { n: 1 } as object };
		const parent = { child };

		unsafeTrack(parent);

		const state = createMutableState({ parent });
		const next = new Map<string, number>([["k", 1]]);

		batch(() => {
			state.parent.child.held = next;
		});

		expect(state.parent.child.held).toBeInstanceOf(Map);
		expect(isSameIdentity(state.parent.child.held, next)).toBe(true);
	});

	it("throws again when a cleared mark re-enters elsewhere", () => {
		const holder = { nested: { n: 1 } as object };

		unsafeTrack(holder);

		const first = createMutableState({ box: holder });

		batch(() => {
			first.box.nested = new Map<string, number>([["a", 1]]);
		});

		expect(first.box.nested).toBeInstanceOf(Map);

		unsafeTrack(holder, false);

		expect(() => createMutableState({ extra: holder })).toThrow("cannot be tracked");
	});

	it("recomputes exemption when a deleted node re-enters the same state while marked", () => {
		const node = { nested: { n: 1 } as object };
		const state = createMutableState({ slot: node as typeof node | undefined });

		batch(() => {
			delete state.slot;
		});

		unsafeTrack(node);

		batch(() => {
			state.slot = node;
			state.slot.nested = new Map<string, number>([["k", 1]]);
		});

		expect(state.slot?.nested).toBeInstanceOf(Map);
	});

	it("recomputes exemption when a deleted exempt node re-enters unmarked", () => {
		const node = { nested: { n: 1 } as object };

		unsafeTrack(node);

		const state = createMutableState({
			slot: node as typeof node | undefined,
			next: 0 as number | typeof node,
		});

		batch(() => {
			delete state.slot;
		});

		unsafeTrack(node, false);

		expect(() => {
			batch(() => {
				state.next = node;
				(state.next as { nested: object }).nested = new Map<string, number>([["k", 1]]);
			});
		}).toThrow("cannot be tracked");
	});
});
