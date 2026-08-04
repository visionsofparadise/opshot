import { createChannel } from "../createChannel";
import { createGroup } from "../createGroup";
import { createMutableState } from "../createMutableState";
import {
	TrackedDate,
	TrackedMap,
	TrackedSet,
	type AssignMutation,
	type DeleteMutation,
	type Mutation,
	type OperationPath,
} from "../index";
import { useMutableState } from "../react/useMutableState";
import { subscribe } from "../subscribe";
import { transact } from "../transact";

interface Doc {
	count: number;
	view: "list" | "detail";
}

interface DocMeta {
	transactionKey?: string;
	replay?: boolean;
}

const makeDoc = (): Doc => ({ count: 0, view: "list" });
const docGroup = createGroup();
const docChannel = createChannel<DocMeta>();
const defaultedChannel = createChannel<{ replay: boolean; transactionKey?: string }>({ replay: false });

describe("typing", () => {
	it("exports the frozen-path two-verb operation surface from the package root", () => {
		expectTypeOf<Mutation>().toEqualTypeOf<AssignMutation | DeleteMutation>();
		expectTypeOf<OperationPath>().toEqualTypeOf<ReadonlyArray<string | number>>();
	});

	it("types address components entirely inside flat paths", () => {
		const operation: Mutation = { verb: "assign", path: ["items", "o3", "id"], value: 2 };

		if (operation.verb !== "assign") throw new Error("expected an assign operation");

		expectTypeOf(operation.path).toEqualTypeOf<OperationPath>();
		expect(operation.path).toEqual(["items", "o3", "id"]);
	});

	it("hides facade backing from package-root class types while retaining runtime data properties", () => {
		const map = new TrackedMap<string, number>();
		const set = new TrackedSet<number>();
		const date = new TrackedDate(0);

		// @ts-expect-error TrackedMap slots is source-private
		void map.slots;
		// @ts-expect-error TrackedMap index is source-private
		void map.index;
		// @ts-expect-error TrackedMap count is source-private
		void map.count;
		// @ts-expect-error TrackedSet slots is source-private
		void set.slots;
		// @ts-expect-error TrackedDate epochMs is source-private
		void date.epochMs;

		expect(Object.keys(map)).toEqual(["slots", "index", "count"]);
		expect(Object.keys(set)).toEqual(["slots", "index", "count"]);
		expect(Object.keys(date)).toEqual(["epochMs"]);
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

	it("types plain subscribe as raw transport meta", () => {
		const state = createMutableState(makeDoc());

		subscribe(state, (ops, meta) => {
			expectTypeOf(ops).toEqualTypeOf<ReadonlyArray<{ readonly do: Mutation; readonly undo: Mutation }>>();
			expectTypeOf(meta).toEqualTypeOf<unknown>();
		});
	});

	it("types channel subscribe with the isTransaction provenance frame", () => {
		const state = createMutableState(makeDoc());

		docChannel.subscribe(state, (ops, context) => {
			expectTypeOf(ops).items.toMatchTypeOf<{ readonly do: Mutation; readonly undo: Mutation }>();

			if (context.isTransaction) {
				expectTypeOf(context.meta).toEqualTypeOf<DocMeta>();
				expectTypeOf(context.meta.replay).toEqualTypeOf<boolean | undefined>();
			} else {
				expectTypeOf(context.meta).toEqualTypeOf<unknown>();
			}
		});

		docChannel.transact(
			state,
			() => {
				state.count = 1;
			},
			{ transactionKey: "drag" },
		);
	});

	it("types channel defaults merge as total M on the true arm", () => {
		const state = createMutableState({ count: 0 });

		defaultedChannel.subscribe(state, (_ops, context) => {
			if (context.isTransaction) {
				expectTypeOf(context.meta.replay).toEqualTypeOf<boolean>();
			} else {
				expectTypeOf(context.meta).toEqualTypeOf<unknown>();
			}
		});
	});

	it("composes useMutableState with an optional group", () => {
		expectTypeOf(useMutableState<Doc>).toBeCallableWith(makeDoc());
		expectTypeOf(useMutableState<Doc>).toBeCallableWith(makeDoc(), { group: docGroup });
	});

	it("delivers merged meta from a defaulted channel at runtime", () => {
		const heard = new Array<{ replay: boolean; transactionKey?: string }>();
		const state = createMutableState({ count: 0 });

		defaultedChannel.subscribe(state, (_ops, context) => {
			if (context.isTransaction) heard.push(context.meta);
		});

		defaultedChannel.transact(state, () => {
			state.count += 1;
		});

		expect(heard).toEqual([{ replay: false }]);
	});
});

export function useHookTypeRejections(): void {
	// @ts-expect-error there is no third argument slot
	useMutableState(makeDoc(), { group: docGroup }, docChannel);
}
