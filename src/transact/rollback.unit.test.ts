import { createMutableState } from "../createMutableState";
import { handleOf } from "../handle";
import { ignore } from "../ignore";
import { rollbackTransaction } from "./rollback";

describe("rollbackTransaction", () => {
	it("restores a replaced object by identity", () => {
		const state = createMutableState({ child: { a: 1, b: 2, c: 3, d: 4, e: 5 } });
		const handle = handleOf(state);
		const held = state.child;

		expect(handle).toBeDefined();

		state.child = { a: 9, b: 9, c: 9, d: 9, e: 9 };
		rollbackTransaction(handle!);

		expect(state.child).toBe(held);
		expect(state.child).toEqual({ a: 1, b: 2, c: 3, d: 4, e: 5 });
	});

	it("leaves an ignore()d mutation standing", () => {
		const bag = { x: 0 };
		const state = createMutableState({ n: 0, bag: ignore(bag) });
		const handle = handleOf(state);

		expect(handle).toBeDefined();

		state.n = 1;
		state.bag.x = 99;
		rollbackTransaction(handle!);

		expect(state.n).toBe(0);
		expect(state.bag.x).toBe(99);
		expect(bag.x).toBe(99);
	});
});
