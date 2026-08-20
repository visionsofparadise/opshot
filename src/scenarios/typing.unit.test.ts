import { createMutableState, type Unmarked } from "../createMutableState";
import { ignore, type Ignored } from "../ignore";
import { type Operation, type OperationPath } from "../index";
import { transact } from "../transact/transact";
import { unsafeTrack, type UnsafeTracked } from "../unsafeTrack";

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

	it("collapses factory-argument markers in the return type", () => {
		const state = createMutableState({
			count: ignore(0),
			lookup: unsafeTrack(new Map<string, number>()),
		});

		expectTypeOf(state).toEqualTypeOf<{ count: number; lookup: Map<string, number> }>();
		expectTypeOf<Unmarked<{ count: Ignored<number>; lookup: UnsafeTracked<Map<string, number>> }>>().toEqualTypeOf<{
			count: number;
			lookup: Map<string, number>;
		}>();
	});
});
