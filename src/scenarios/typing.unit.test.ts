import { createMutableState } from "../createMutableState";
import { type Operation, type OperationPath } from "../index";
import { transact } from "../transact/transact";

interface Doc {
	count: number;
	view: "list" | "detail";
}

const makeDoc = (): Doc => ({ count: 0, view: "list" });

describe("typing", () => {
	it("exports Operation and OperationPath from the package root", () => {
		expectTypeOf<Operation>().toMatchTypeOf<{
			readonly do: { readonly verb: string; readonly path: OperationPath };
			readonly undo: { readonly verb: string; readonly path: OperationPath };
		}>();
		expectTypeOf<OperationPath>().toEqualTypeOf<ReadonlyArray<string | number>>();
	});

	it("types createMutableState as the live object T", () => {
		const state = createMutableState<Doc>(makeDoc());

		expectTypeOf(state).toEqualTypeOf<Doc>();
		expectTypeOf(state.count).toEqualTypeOf<number>();

		state.count = 1;
		transact(state, () => {
			state.view = "detail";
		});
	});
});
