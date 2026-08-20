import { createMutableState } from "./createMutableState";
import { isSameIdentity } from "./identity";
import { ignore } from "./ignore";
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

	it("A.foo = ignore(obj) is untracked on A and B.foo = obj is ordinary", () => {
		const obj = { n: 1 };
		const stateA = createMutableState<{ foo: { n: number } | null; tick: number }>({ foo: null, tick: 0 });
		const stateB = createMutableState<{ foo: { n: number } | null }>({ foo: null });
		const heardA = new Array<Array<Operation>>();
		const heardB = new Array<Array<Operation>>();

		subscribe(stateA, (ops) => heardA.push([...ops]));
		subscribe(stateB, (ops) => heardB.push([...ops]));

		transact(stateA, () => {
			stateA.foo = ignore(obj);
		});
		transact(stateB, () => {
			stateB.foo = obj;
		});

		expect(stateA.foo).toBe(obj);
		expect(stateB.foo !== null && isSameIdentity(stateB.foo, obj)).toBe(true);

		heardA.length = 0;
		heardB.length = 0;

		transact(stateA, () => {
			stateA.foo!.n = 5;
			stateA.tick = 1;
		});

		expect(shapeOps(heardA[0] ?? [])).toEqual([
			{ do: { verb: "assign", path: ["tick"], value: 1 }, undo: { verb: "assign", path: ["tick"], value: 0 } },
		]);

		heardB.length = 0;

		transact(stateB, () => {
			stateB.foo!.n = 7;
		});

		expect(heardB).toHaveLength(1);
		expect(heardB[0]?.[0]?.do).toMatchObject({ verb: "assign", path: ["foo", "n"], value: 7 });
	});
});
