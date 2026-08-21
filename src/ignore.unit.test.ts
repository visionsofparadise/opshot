import { createMutableState } from "./createMutableState";
import { ignore, ignoreMarker } from "./ignore";
import { type Operation } from "./ops/operation";
import { shapeOps } from "./ops/operationShape";
import { subscribe } from "./subscribe";
import { transact } from "./transact/transact";

describe("ignore", () => {
	it("keeps an ignored value's interior writable and shares the same reference", () => {
		const element = { currentTime: 0 };
		const state = createMutableState({ position: 0, element: ignore(element) });

		state.element.currentTime = 5;

		expect(element.currentTime).toBe(5);
		expect(state.element).toBe(element);
	});

	it("leaves an ignore(2) factory edge untracked", () => {
		const state = createMutableState({ n: ignore(2), tick: 0 });
		const heard = new Array<Array<Operation>>();

		subscribe(state, (ops) => heard.push([...ops]));

		transact(state, () => {
			state.n = 9;
			state.tick = 1;
		});

		expect(state.n).toBe(9);
		expect(shapeOps(heard[0] ?? [])).toEqual([
			{ do: { verb: "assign", path: ["tick"], value: 1 }, undo: { verb: "assign", path: ["tick"], value: 0 } },
		]);
	});

	it("keeps a create-time ignored path untracked after reassignment", () => {
		const first = { n: 1 };
		const second = { n: 2 };
		const state = createMutableState({ foo: ignore(first), tick: 0 });
		const heard = new Array<Array<Operation>>();

		subscribe(state, (ops) => heard.push([...ops]));

		transact(state, () => {
			state.foo = second;
			state.tick = 1;
		});

		expect(state.foo).toBe(second);
		expect(shapeOps(heard[0] ?? [])).toEqual([
			{ do: { verb: "assign", path: ["tick"], value: 1 }, undo: { verb: "assign", path: ["tick"], value: 0 } },
		]);

		heard.length = 0;

		transact(state, () => {
			state.foo.n = 5;
			state.tick = 2;
		});

		expect(shapeOps(heard[0] ?? [])).toEqual([
			{ do: { verb: "assign", path: ["tick"], value: 2 }, undo: { verb: "assign", path: ["tick"], value: 1 } },
		]);
	});

	it("untracks a nested ignore under every occupancy of a shared node", () => {
		const holder = { nested: ignore({ n: 1 }) };
		const state = createMutableState({ a: holder, b: holder, tick: 0 });
		const heard = new Array<Array<Operation>>();

		subscribe(state, (ops) => heard.push([...ops]));

		transact(state, () => {
			state.a.nested = { n: 9 };
			state.tick = 1;
		});

		expect(shapeOps(heard[0] ?? [])).toEqual([
			{ do: { verb: "assign", path: ["tick"], value: 1 }, undo: { verb: "assign", path: ["tick"], value: 0 } },
		]);

		heard.length = 0;

		transact(state, () => {
			state.b.nested = { n: 8 };
			state.tick = 2;
		});

		expect(shapeOps(heard[0] ?? [])).toEqual([
			{ do: { verb: "assign", path: ["tick"], value: 2 }, undo: { verb: "assign", path: ["tick"], value: 1 } },
		]);
	});

	it("instruments a tracked occupancy when another occupancy of the node is ignored", () => {
		const holder = { nested: { n: 1 } };
		const state = createMutableState({ a: ignore(holder), b: holder, tick: 0 });
		const heard = new Array<Array<Operation>>();

		subscribe(state, (ops) => heard.push([...ops]));

		transact(state, () => {
			state.a.nested = { n: 3 };
			state.tick = 1;
		});

		expect(shapeOps(heard[0] ?? [])).toEqual([
			{ do: { verb: "assign", path: ["tick"], value: 1 }, undo: { verb: "assign", path: ["tick"], value: 0 } },
		]);

		heard.length = 0;

		transact(state, () => {
			state.b.nested = { n: 9 };
		});

		expect(shapeOps(heard[0] ?? [])).toEqual([
			{
				do: { verb: "assign", path: ["b", "nested"], value: { n: 9 } },
				undo: { verb: "assign", path: ["b", "nested"], value: { n: 1 } },
			},
		]);

		heard.length = 0;

		transact(state, () => {
			state.b.nested.n = 10;
		});

		expect(shapeOps(heard[0] ?? [])).toEqual([
			{
				do: { verb: "assign", path: ["b", "nested", "n"], value: 10 },
				undo: { verb: "assign", path: ["b", "nested", "n"], value: 9 },
			},
		]);
	});

	it("emits nothing for a write under a create-time ignored ancestor", () => {
		const nested = { n: 1 };
		const state = createMutableState({ box: ignore({ nested }), tick: 0 });
		const heard = new Array<Array<Operation>>();

		subscribe(state, (ops) => heard.push([...ops]));

		transact(state, () => {
			state.box.nested.n = 2;
			state.tick = 1;
		});

		expect(nested.n).toBe(2);
		expect(shapeOps(heard[0] ?? [])).toEqual([
			{ do: { verb: "assign", path: ["tick"], value: 1 }, undo: { verb: "assign", path: ["tick"], value: 0 } },
		]);
	});

	it("lands a live ignore() assignment as a ride-along-bearing object", () => {
		const obj = { n: 1 };
		const state = createMutableState<{ foo: unknown }>({ foo: null });

		transact(state, () => {
			state.foo = ignore(obj);
		});

		expect(state.foo).not.toBe(obj);
		expect(typeof state.foo === "object" && state.foo !== null && Object.hasOwn(state.foo, ignoreMarker)).toBe(true);
	});

	it("keeps a nested ignore after the intermediate node is replaced", () => {
		const state = createMutableState({ box: { nested: ignore({ n: 1 }) }, tick: 0 });
		const heard = new Array<Array<Operation>>();

		subscribe(state, (ops) => heard.push([...ops]));

		transact(state, () => {
			state.box = { nested: { n: 2 } };
			state.tick = 1;
		});

		const replacement = { n: 9 };

		heard.length = 0;

		transact(state, () => {
			state.box.nested = replacement;
			state.tick = 2;
		});

		expect(state.box.nested).toBe(replacement);
		expect(shapeOps(heard[0] ?? [])).toEqual([
			{ do: { verb: "assign", path: ["tick"], value: 2 }, undo: { verb: "assign", path: ["tick"], value: 1 } },
		]);
	});

	it("does not proxy a replacement occupant when any grounded path of the slot is a declared ignore frontier", () => {
		const state = createMutableState({
			a: { slot: ignore({ n: 1 }) },
			b: { slot: { n: 2 } },
			tick: 0,
		});
		const heard = new Array<Array<Operation>>();

		subscribe(state, (ops) => heard.push([...ops]));

		transact(state, () => {
			state.a = state.b;
		});

		const next = { n: 9 };

		heard.length = 0;

		transact(state, () => {
			state.b.slot = next;
			state.tick = 1;
		});

		expect(state.b.slot).toBe(next);
		expect(state.a.slot).toBe(next);
		expect(shapeOps(heard[0] ?? [])).toEqual([
			{ do: { verb: "assign", path: ["tick"], value: 1 }, undo: { verb: "assign", path: ["tick"], value: 0 } },
		]);
	});
});
