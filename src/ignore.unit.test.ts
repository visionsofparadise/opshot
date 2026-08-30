import { createMutableState } from "./createMutableState";
import { handleOf } from "./handle";
import { ignore, isIgnored } from "./ignore";
import { unsafeTrack } from "./unsafeTrack";
import { type Operation } from "./ops/operation";
import { shapeOps } from "./ops/operationShape";
import { subscribe } from "./subscribe";
import { batch } from "./batch";

describe("ignore", () => {
	it("keeps an ignored value's interior writable and shares the same reference", () => {
		const element = { currentTime: 0 };
		const state = createMutableState({ position: 0, element: ignore(element) });

		state.element.currentTime = 5;

		expect(element.currentTime).toBe(5);
		expect(state.element).toBe(element);
	});

	it("leaves an ignore(2) factory edge tracked because primitives are unmarked", () => {
		const state = createMutableState({ n: ignore(2), tick: 0 });
		const heard = new Array<Array<Operation>>();

		subscribe(state, (ops) => heard.push([...ops]));

		batch(() => {
			state.n = 9;
			state.tick = 1;
		});

		expect(state.n).toBe(9);
		expect(shapeOps(heard[0] ?? [])).toEqual([
			{ do: { verb: "assign", path: ["n"], value: 9 }, undo: { verb: "assign", path: ["n"], value: 2 } },
			{ do: { verb: "assign", path: ["tick"], value: 1 }, undo: { verb: "assign", path: ["tick"], value: 0 } },
		]);
	});

	it("tracks a later unmarked occupant after a create-time ignored assignment", () => {
		const first = { n: 1 };
		const second = { n: 2 };
		const state = createMutableState({ foo: ignore(first), tick: 0 });
		const heard = new Array<Array<Operation>>();

		subscribe(state, (ops) => heard.push([...ops]));

		batch(() => {
			state.foo = second;
			state.tick = 1;
		});

		expect(state.foo).not.toBe(second);
		expect(heard[0]?.[0]?.do).toMatchObject({ verb: "assign", path: ["foo"], value: { n: 2 } });

		heard.length = 0;

		batch(() => {
			state.foo.n = 5;
			state.tick = 2;
		});

		expect(shapeOps(heard[0] ?? [])).toEqual([
			{
				do: { verb: "assign", path: ["foo", "n"], value: 5 },
				undo: { verb: "assign", path: ["foo", "n"], value: 2 },
			},
			{ do: { verb: "assign", path: ["tick"], value: 2 }, undo: { verb: "assign", path: ["tick"], value: 1 } },
		]);
	});

	it("tracks a replacement at a nested ignore whose occupant was identity-marked", () => {
		const holder = { nested: ignore({ n: 1 }) };
		const state = createMutableState({ a: holder, b: holder, tick: 0 });
		const heard = new Array<Array<Operation>>();

		subscribe(state, (ops) => heard.push([...ops]));

		batch(() => {
			state.a.nested = { n: 9 };
			state.tick = 1;
		});

		expect(heard[0]?.some((operation) => operation.do.verb === "assign" && operation.do.path[1] === "nested")).toBe(
			true,
		);

		heard.length = 0;

		batch(() => {
			state.b.nested = { n: 8 };
			state.tick = 2;
		});

		expect(heard[0]?.some((operation) => operation.do.verb === "assign" && operation.do.path[1] === "nested")).toBe(
			true,
		);
	});

	it("untracks every occupancy of a node marked before it enters", () => {
		const holder = { nested: { n: 1 } };
		const state = createMutableState({ a: ignore(holder), b: holder, tick: 0 });
		const heard = new Array<Array<Operation>>();

		subscribe(state, (ops) => heard.push([...ops]));

		batch(() => {
			state.a.nested = { n: 3 };
			state.tick = 1;
		});

		expect(shapeOps(heard[0] ?? [])).toEqual([
			{ do: { verb: "assign", path: ["tick"], value: 1 }, undo: { verb: "assign", path: ["tick"], value: 0 } },
		]);

		heard.length = 0;

		batch(() => {
			state.b.nested = { n: 9 };
			state.tick = 2;
		});

		expect(shapeOps(heard[0] ?? [])).toEqual([
			{ do: { verb: "assign", path: ["tick"], value: 2 }, undo: { verb: "assign", path: ["tick"], value: 1 } },
		]);
	});

	it("emits nothing for a write under a create-time ignored ancestor", () => {
		const nested = { n: 1 };
		const state = createMutableState({ box: ignore({ nested }), tick: 0 });
		const heard = new Array<Array<Operation>>();

		subscribe(state, (ops) => heard.push([...ops]));

		batch(() => {
			state.box.nested.n = 2;
			state.tick = 1;
		});

		expect(nested.n).toBe(2);
		expect(shapeOps(heard[0] ?? [])).toEqual([
			{ do: { verb: "assign", path: ["tick"], value: 1 }, undo: { verb: "assign", path: ["tick"], value: 0 } },
		]);
	});

	it("lands a live ignore() assignment as the marked object, untracked", () => {
		const obj = { n: 1 };
		const state = createMutableState<{ foo: unknown }>({ foo: null });

		batch(() => {
			state.foo = ignore(obj);
		});

		expect(state.foo).toBe(obj);
		expect(isIgnored(obj)).toBe(true);
	});

	it("tracks a nested slot after the intermediate node is replaced", () => {
		const state = createMutableState({ box: { nested: ignore({ n: 1 }) }, tick: 0 });
		const heard = new Array<Array<Operation>>();

		subscribe(state, (ops) => heard.push([...ops]));

		batch(() => {
			state.box = { nested: { n: 2 } };
			state.tick = 1;
		});

		const replacement = { n: 9 };

		heard.length = 0;

		batch(() => {
			state.box.nested = replacement;
			state.tick = 2;
		});

		expect(state.box.nested).not.toBe(replacement);
		expect(heard[0]?.some((operation) => operation.do.verb === "assign" && operation.do.path[1] === "nested")).toBe(
			true,
		);
	});

	it("proxies a replacement occupant after aliasing a parent that had one ignored factory occupancy", () => {
		const state = createMutableState({
			a: { slot: ignore({ n: 1 }) },
			b: { slot: { n: 2 } },
			tick: 0,
		});
		const heard = new Array<Array<Operation>>();

		subscribe(state, (ops) => heard.push([...ops]));

		batch(() => {
			state.a = state.b;
		});

		const next = { n: 9 };

		heard.length = 0;

		batch(() => {
			state.b.slot = next;
			state.tick = 1;
		});

		expect(state.b.slot).not.toBe(next);
		expect(state.a.slot).toBe(state.b.slot);
		expect(heard[0]?.some((operation) => operation.do.verb === "assign" && operation.do.path[1] === "slot")).toBe(
			true,
		);
	});

	it("grounds a replacement after a clean-chain alias of a parent that had one ignored factory occupancy", () => {
		const state = createMutableState({
			a: { x: { hide: ignore({ s: 1 }) } },
			b: { x: { other: unsafeTrack({ t: 1 }) } },
		} as unknown as {
			a: { x: { hide?: { s: number }; other?: { t: number } } };
			b: { x: { hide?: { s: number }; other?: { t: number } } };
		});

		batch(() => {
			state.b = state.a;
		});

		const replacement = { s: 2 };

		batch(() => {
			state.a.x = { hide: replacement };
		});

		expect(state.a.x.hide).not.toBe(replacement);

		const handle = handleOf(state);

		expect(handle).toBeDefined();
		expect((handle!.nodes.get(replacement)?.edges.length ?? 0) > 0).toBe(true);
	});

	it("grounds a hide assignment after a back-pointer cycle aliases a parent that had one ignored factory occupancy", () => {
		const state = createMutableState({
			c: { k1: {}, w: { k2: { hide: ignore({ s: 1 }) } } },
		} as unknown as {
			c: {
				k1: { hide?: { s: number } };
				w: { z?: object; k2: { hide?: { s: number } } };
			};
		});
		const handle = handleOf(state);

		expect(handle).toBeDefined();

		state.c.w.z = state.c;
		state.c.w.k2 = state.c.k1;

		const replacement = { s: 2 };

		state.c.k1.hide = replacement;

		expect(state.c.k1.hide).not.toBe(replacement);
		expect((handle!.nodes.get(replacement)?.edges.length ?? 0) > 0).toBe(true);
	});

	it("untracks a marked object at every path in every state that receives it", () => {
		const node = { n: 1 };

		ignore(node);

		const first = createMutableState({ box: node, tick: 0 });
		const second = createMutableState({ box: node, tick: 0 });
		const heardFirst = new Array<Array<Operation>>();
		const heardSecond = new Array<Array<Operation>>();

		subscribe(first, (ops) => heardFirst.push([...ops]));
		subscribe(second, (ops) => heardSecond.push([...ops]));

		batch(() => {
			first.box.n = 2;
			first.tick = 1;
		});

		batch(() => {
			second.box.n = 3;
			second.tick = 1;
		});

		expect(first.box).toBe(node);
		expect(second.box).toBe(node);
		expect(shapeOps(heardFirst[0] ?? [])).toEqual([
			{ do: { verb: "assign", path: ["tick"], value: 1 }, undo: { verb: "assign", path: ["tick"], value: 0 } },
		]);
		expect(shapeOps(heardSecond[0] ?? [])).toEqual([
			{ do: { verb: "assign", path: ["tick"], value: 1 }, undo: { verb: "assign", path: ["tick"], value: 0 } },
		]);
	});

	it("clears with ignore(value, false) and a clear between two assignments changes only the later edge", () => {
		const node = { n: 1 };

		ignore(node);

		const state = createMutableState({ hid: node as { n: number }, shown: { n: 0 }, tick: 0 });
		const heard = new Array<Array<Operation>>();

		subscribe(state, (ops) => heard.push([...ops]));

		ignore(node, false);

		batch(() => {
			state.shown = node;
			state.tick = 1;
		});

		expect(state.hid).toBe(node);
		expect(state.shown).not.toBe(node);

		heard.length = 0;

		batch(() => {
			state.hid.n = 8;
			state.tick = 2;
		});

		expect(shapeOps(heard[0] ?? [])).toEqual([
			{ do: { verb: "assign", path: ["tick"], value: 2 }, undo: { verb: "assign", path: ["tick"], value: 1 } },
		]);

		heard.length = 0;

		batch(() => {
			state.shown.n = 9;
		});

		expect(shapeOps(heard[0] ?? [])).toEqual([
			{
				do: { verb: "assign", path: ["shown", "n"], value: 9 },
				undo: { verb: "assign", path: ["shown", "n"], value: 1 },
			},
		]);
	});

	it("leaves an existing edge tracked when the occupant is marked after assignment", () => {
		const node = { n: 1 };
		const state = createMutableState({ box: node, tick: 0 });
		const heard = new Array<Array<Operation>>();

		subscribe(state, (ops) => heard.push([...ops]));

		ignore(node);

		batch(() => {
			state.box.n = 2;
			state.tick = 1;
		});

		expect(shapeOps(heard[0] ?? [])).toEqual([
			{
				do: { verb: "assign", path: ["box", "n"], value: 2 },
				undo: { verb: "assign", path: ["box", "n"], value: 1 },
			},
			{ do: { verb: "assign", path: ["tick"], value: 1 }, undo: { verb: "assign", path: ["tick"], value: 0 } },
		]);
	});

	it("leaves an existing edge tracked when ignore is called on the proxy after assignment", () => {
		const state = createMutableState({ box: { n: 1 }, tick: 0 });
		const heard = new Array<Array<Operation>>();

		subscribe(state, (ops) => heard.push([...ops]));

		ignore(state.box);

		batch(() => {
			state.box.n = 2;
			state.tick = 1;
		});

		expect(shapeOps(heard[0] ?? [])).toEqual([
			{
				do: { verb: "assign", path: ["box", "n"], value: 2 },
				undo: { verb: "assign", path: ["box", "n"], value: 1 },
			},
			{ do: { verb: "assign", path: ["tick"], value: 1 }, undo: { verb: "assign", path: ["tick"], value: 0 } },
		]);
	});

	it("returns a primitive or null unmarked", () => {
		expect(ignore(5)).toBe(5);
		expect(ignore(null)).toBe(null);
	});
});
