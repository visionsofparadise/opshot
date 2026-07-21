import { createGroup } from "../createGroup";
import { createMeta } from "../createMeta";
import { createState, type Emission, type State } from "../createState";
import {
	TrackedDate,
	TrackedMap,
	TrackedSet,
	type AddOperation,
	type Operation,
	type OperationPath,
	type RemoveOperation,
	type ReplaceOperation,
} from "../index";
import { useTrackedState } from "../react/useTrackedState";

interface Doc {
	count: number;
	view: "list" | "detail";
}

interface DocMeta {
	transactionKey?: string;
	replay?: boolean;
}

interface RequiredMeta {
	source: string;
}

const makeDoc = (): Doc => ({ count: 0, view: "list" });
const docMeta = createMeta<DocMeta>();
const docGroup = createGroup(docMeta);
const requiredMeta = createMeta<RequiredMeta>();
const requiredGroup = createGroup(requiredMeta);

// The settled type surface, pinned with expectTypeOf/@ts-expect-error inside real test blocks. tsc
// checks every line via `npm run check`, and an unused @ts-expect-error is itself a tsc error, so the
// pins are self-verifying. The final block is the one runtime assertion.
describe("typing", () => {
	it("exports the frozen-path three-verb operation surface from the package root", () => {
		expectTypeOf<Operation>().toEqualTypeOf<AddOperation | ReplaceOperation | RemoveOperation>();
		expectTypeOf<OperationPath>().toEqualTypeOf<ReadonlyArray<unknown>>();
	});

	it("types address components entirely inside flat paths", () => {
		const key = { id: 1 };
		const operation: Operation = { op: "replace", path: ["map", key, "id"], value: 2 };

		if (operation.op !== "replace") throw new Error("expected a replace operation");

		expectTypeOf(operation.path).toEqualTypeOf<OperationPath>();
		expect(operation.path).toEqual(["map", key, "id"]);
	});

	it("hides facade backing from package-root class types while retaining runtime data properties", () => {
		const map = new TrackedMap<string, number>();
		const set = new TrackedSet<number>();
		const date = new TrackedDate(0);

		// @ts-expect-error TrackedMap backing is source-private
		void map.data;
		// @ts-expect-error TrackedSet backing is source-private
		void set.data;
		// @ts-expect-error TrackedDate backing is source-private
		void date.epochMs;

		expect(Object.keys(map)).toEqual(["data"]);
		expect(Object.keys(set)).toEqual(["data"]);
		expect(Object.keys(date)).toEqual(["epochMs"]);
	});

	it("pins explicit <T> to the {} meta defaults, not the token's types", () => {
		const withToken = createState<Doc>(makeDoc, docMeta);

		expectTypeOf(withToken).toEqualTypeOf<State<Doc, {}, {}>>();

		// write side goes unchecked under the {} slot -- a bogus meta key compiles
		withToken.mutate((mutable) => void mutable, { bogusKey: 123 });

		withToken.op.subscribe((_state, _ops, emission) => {
			if (emission.isSideEffect) return;

			// @ts-expect-error property replay does not exist on {}
			void emission.meta.replay;
		});

		withToken.op.subscribe((_state, _ops, emission: Emission<DocMeta>) => {
			if (emission.isSideEffect) return;

			expectTypeOf(emission.meta.replay).toEqualTypeOf<boolean | undefined>();
		});
	});

	it("refuses explicit <T> with a required-field token", () => {
		// @ts-expect-error Meta<RequiredMeta> does not pass the {}-defaulted slot
		createState<Doc>(makeDoc, requiredMeta);
	});

	it("infers meta from the token when <T> is left open", () => {
		const tokenState = createState(makeDoc, docMeta);
		const requiredState = createState(makeDoc, requiredMeta);

		expectTypeOf(tokenState).toEqualTypeOf<State<Doc, DocMeta, DocMeta>>();
		expectTypeOf(requiredState).toEqualTypeOf<State<Doc, RequiredMeta, RequiredMeta>>();

		tokenState.mutate((mutable) => void mutable);

		// @ts-expect-error meta is required when In carries a required field
		requiredState.mutate((mutable) => void mutable);
		requiredState.mutate((mutable) => void mutable, { source: "user" });

		const prop: State<Doc> = tokenState;
		void prop;

		// @ts-expect-error required-meta mutate cannot satisfy optional-meta mutate
		const bad: State<Doc> = requiredState;
		void bad;
	});

	it("composes explicit <T> with a group or token in the single groupOrMeta slot (feedback item 2)", () => {
		expectTypeOf(useTrackedState<Doc>).toBeCallableWith(makeDoc, docGroup);
		expectTypeOf(useTrackedState<Doc>).toBeCallableWith(makeDoc, docMeta);
		expectTypeOf(useTrackedState<Doc>).toBeCallableWith(makeDoc);
	});

	it("delivers merged meta from a state created with a token", () => {
		const token = createMeta<{ replay: boolean }>({ replay: false });
		const heard = new Array<{ replay: boolean }>();

		const state = createState({ count: 0 }, token);

		state.op.subscribe((_state, _ops, emission) => {
			if (!emission.isSideEffect) heard.push(emission.meta);
		});

		state.mutate((mutable) => {
			mutable.count += 1;
		});

		expect(heard).toEqual([{ replay: false }]);
	});
});

// The rejection half of the hook surface: a hook can't be invoked outside React and vitest has no
// `.not.toBeCallableWith`, so these type-only pins live in a never-invoked function -- tsc still
// checks every line, so an unused @ts-expect-error would fail the build.
export function useHookTypeRejections(): void {
	// @ts-expect-error Group<RequiredMeta> does not pass the {}-defaulted slot
	useTrackedState<Doc>(makeDoc, requiredGroup);
	// @ts-expect-error Meta<RequiredMeta> does not pass the {}-defaulted slot
	useTrackedState<Doc>(makeDoc, requiredMeta);
	// @ts-expect-error there is no third argument slot for a second binder
	useTrackedState(makeDoc, docGroup, docMeta);
}
