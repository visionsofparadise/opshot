import { createMutableState } from "../createMutableState";
import { ignore } from "../ignore";
import { type Operation } from "../ops/operation";
import { subscribe } from "../subscribe";
import { transact } from "./transact";

describe("transact", () => {
	it("runs the callback synchronously and delivers its writes as one emission", () => {
		const state = createMutableState({ a: 0, b: 0 });
		const heard = new Array<Array<Operation>>();

		subscribe(state, (ops) => heard.push([...ops]));

		transact(state, () => {
			state.a = 1;
			state.b = 2;
		});

		expect(state.a).toBe(1);
		expect(state.b).toBe(2);
		expect(heard).toHaveLength(1);
		expect(heard[0]?.map((operation) => operation.do.path)).toEqual([["a"], ["b"]]);
	});

	it("emits a state's pending Writes before that state's Transaction write", async () => {
		const state = createMutableState({ a: { n: 0 }, bare: 0 });
		const heard = new Array<Array<Operation>>();

		subscribe(state, (ops) => heard.push([...ops]));

		state.bare = 1;

		transact(state, () => {
			state.a.n = 1;
		});

		expect(heard.map((ops) => ops.map((operation) => operation.do.path))).toEqual([[["bare"]], [["a", "n"]]]);

		await Promise.resolve();

		expect(heard).toHaveLength(2);
	});

	it("restores tracked nodes and emits nothing when the callback throws", async () => {
		const state = createMutableState({ a: { n: 0 } });
		const heard = new Array<Array<Operation>>();

		subscribe(state, (ops) => heard.push([...ops]));

		expect(() =>
			transact(state, () => {
				state.a.n = 1;

				throw new Error("mutate failure");
			}),
		).toThrow("mutate failure");
		expect(state.a.n).toBe(0);
		expect(heard).toEqual([]);

		await Promise.resolve();

		expect(heard).toEqual([]);
	});

	it("restores a replaced object by identity when the callback throws", () => {
		const state = createMutableState({ child: { a: 1, b: 2, c: 3, d: 4, e: 5 } });
		const held = state.child;

		subscribe(state, () => undefined);

		expect(() =>
			transact(state, () => {
				state.child = { a: 9, b: 9, c: 9, d: 9, e: 9 };

				throw new Error("abort");
			}),
		).toThrow("abort");

		expect(state.child).toBe(held);
		expect(state.child).toEqual({ a: 1, b: 2, c: 3, d: 4, e: 5 });
	});

	it("emits pending Writes and restores the transaction when the callback throws", async () => {
		const state = createMutableState({ a: { n: 0 }, bare: 0 });
		const heard = new Array<Array<Operation>>();

		subscribe(state, (ops) => heard.push([...ops]));

		state.bare = 1;

		expect(() =>
			transact(state, () => {
				state.a.n = 1;
				state.bare = 2;

				throw new Error("abort");
			}),
		).toThrow("abort");

		expect(state.a.n).toBe(0);
		expect(state.bare).toBe(1);
		expect(heard.map((ops) => ops.map((operation) => operation.do.path))).toEqual([[["bare"]]]);

		await Promise.resolve();

		expect(heard).toHaveLength(1);
		expect(state.bare).toBe(1);
	});

	it("leaves an ignore()d mutation standing when the callback throws", () => {
		const bag = { x: 0 };
		const state = createMutableState({ n: 0, bag: ignore(bag) });

		subscribe(state, () => undefined);

		expect(() =>
			transact(state, () => {
				state.n = 1;
				state.bag.x = 99;

				throw new Error("abort");
			}),
		).toThrow("abort");

		expect(state.n).toBe(0);
		expect(state.bag.x).toBe(99);
		expect(bag.x).toBe(99);
	});
});
