import { snapshot } from "valtio/vanilla";

import { createMutableState } from "../createMutableState";
import { applyMutations } from "./applyMutations";
import {
	createAssignMutation,
	createDeleteMutation,
	createLinkMutation,
	type Mutation,
	type Operation,
} from "./operation";
import { MAX_ARRAY_LENGTH } from "./predicates";

const asPair = (half: Mutation): Operation => ({ do: half, undo: half });

const applyConstruct = (root: object, ops: ReadonlyArray<Operation>): void =>
	applyMutations(root, ops, "do", "construct");

describe("applyMutations: address resolution", () => {
	it("refuses malformed addresses before mutating anything", () => {
		const unresolved = "does not resolve to a supported operation address";

		const cases: ReadonlyArray<{
			readonly name: string;
			readonly setup: () => { readonly state: object; readonly ops: Array<Operation>; readonly probe: () => void };
		}> = [
			{
				name: "non-canonical array index",
				setup: () => {
					const state = createMutableState({ list: [1] });

					return {
						state,
						ops: [asPair(createAssignMutation(["list", "0"], 2))],
						probe: () => {
							expect(state.list[0]).toBe(1);
						},
					};
				},
			},
			{
				name: "non-string segment",
				setup: () => {
					const state = createMutableState({ held: { a: 1 } });

					return {
						state,
						ops: [asPair(createAssignMutation(["held", 0], 2))],
						probe: () => {
							expect(state.held).toEqual({ a: 1 });
						},
					};
				},
			},
			{
				name: "traversal through a leaf",
				setup: () => {
					const state = createMutableState({ count: 0 });

					return {
						state,
						ops: [asPair(createAssignMutation(["count", "nested"], 1))],
						probe: () => {
							expect(state.count).toBe(0);
						},
					};
				},
			},
			{
				name: "empty path",
				setup: () => {
					const state = createMutableState({ count: 0 });

					return {
						state,
						ops: [asPair(createAssignMutation([], { count: 1 }))],
						probe: () => {
							expect(state.count).toBe(0);
						},
					};
				},
			},
			{
				name: "out-of-range length assign",
				setup: () => {
					const state = createMutableState({ list: [1] });

					return {
						state,
						ops: [asPair(createAssignMutation(["list", "length"], MAX_ARRAY_LENGTH + 1))],
						probe: () => {
							expect(state.list).toHaveLength(1);
							expect(state.list[0]).toBe(1);
						},
					};
				},
			},
			{
				name: "assign at a non-enumerable own key",
				setup: () => {
					const bag: Record<string, unknown> = { visible: 1 };

					Object.defineProperty(bag, "hidden", {
						value: 2,
						enumerable: false,
						writable: true,
						configurable: true,
					});

					const state = createMutableState({ bag });

					return {
						state,
						ops: [asPair(createAssignMutation(["bag", "hidden"], 9))],
						probe: () => {
							expect(state.bag.visible).toBe(1);
							expect(Reflect.getOwnPropertyDescriptor(state.bag, "hidden")?.value).toBe(2);
						},
					};
				},
			},
		];

		for (const row of cases) {
			const { state, ops, probe } = row.setup();

			expect(() => applyConstruct(state, ops), row.name).toThrow(unresolved);
			probe();
		}
	});

	it("refuses assign and link at an inherited accessor without invoking the setter, including a hand-built __proto__ path", () => {
		let calls = 0;

		Object.defineProperty(Object.prototype, "opshotInheritedSetter", {
			set: () => {
				calls += 1;
			},
			configurable: true,
		});

		try {
			const state = createMutableState<{ shared: { n: number } } & Record<string, unknown>>({
				shared: { n: 1 },
			});

			expect(() => applyConstruct(state, [asPair(createAssignMutation(["opshotInheritedSetter"], 1))])).toThrow(
				"resolves to an inherited accessor",
			);
			expect(() =>
				applyConstruct(state, [asPair(createLinkMutation(["opshotInheritedSetter"], ["shared"]))]),
			).toThrow("resolves to an inherited accessor");
			expect(calls).toBe(0);
			expect(Object.hasOwn(state, "opshotInheritedSetter")).toBe(false);

			expect(() =>
				applyConstruct(state, [asPair(createAssignMutation(["__proto__"], { polluted: "PWNED" }))]),
			).toThrow("resolves to an inherited accessor");
			expect(() => applyConstruct(state, [asPair(createLinkMutation(["__proto__"], ["shared"]))])).toThrow(
				"resolves to an inherited accessor",
			);
			expect(Object.prototype).not.toHaveProperty("polluted");
			expect(Reflect.getPrototypeOf(state)).toBe(Object.prototype);
		} finally {
			Reflect.deleteProperty(Object.prototype, "opshotInheritedSetter");
		}
	});

	it("refuses a link at the empty path, at array length, and through a ref segment that is not an object naming both path and ref", () => {
		const state = createMutableState<{ list: Array<number>; shared: { n: number }; count: number; alias?: object }>({
			list: [1],
			shared: { n: 1 },
			count: 1,
		});

		expect(() => applyConstruct(state, [asPair(createLinkMutation([], ["shared"]))])).toThrow(
			"link at / with ref /shared does not resolve to a supported operation address",
		);
		expect(() => applyConstruct(state, [asPair(createLinkMutation(["list", "length"], ["shared"]))])).toThrow(
			"link at /list/length with ref /shared cannot address array length",
		);
		expect(() => applyConstruct(state, [asPair(createLinkMutation(["alias"], ["count"]))])).toThrow(
			"link at /alias with ref /count resolves to a non-object",
		);
		expect(state.list).toEqual([1]);
		expect(Object.hasOwn(state, "alias")).toBe(false);
	});

	it("a wholesale-restore undo drops keys absent from the record while leaving non-writable and ride-along keys untouched", () => {
		const symbolKey = Symbol("ride");
		const held: Record<string, unknown> = { keep: 1, drop: 2 };

		Object.defineProperty(held, "hidden", {
			value: "secret",
			enumerable: false,
			writable: true,
			configurable: true,
		});
		Object.defineProperty(held, "locked", {
			value: "locked",
			enumerable: true,
			writable: false,
			configurable: true,
		});
		Object.defineProperty(held, symbolKey, {
			value: "symbol",
			enumerable: true,
			writable: true,
			configurable: true,
		});

		const state = createMutableState({ held });
		const recorded = snapshot(state.held);

		held.keep = 99;
		held.extra = "added";
		Reflect.set(held, "hidden", "post-hidden");
		Reflect.set(held, symbolKey, "post-symbol");

		const hiddenMutated = Reflect.getOwnPropertyDescriptor(state.held, "hidden");
		const lockedMutated = Reflect.getOwnPropertyDescriptor(state.held, "locked");
		const symbolMutated = Reflect.getOwnPropertyDescriptor(state.held, symbolKey);

		applyMutations(
			state,
			[
				{
					do: createDeleteMutation(["held"]),
					undo: createAssignMutation(["held"], {}, recorded),
				},
			],
			"undo",
			"restore",
		);

		expect(Object.hasOwn(state.held, "extra")).toBe(false);
		expect(state.held.keep).toBe(1);
		expect(state.held.drop).toBe(2);
		expect(Reflect.getOwnPropertyDescriptor(state.held, "hidden")).toEqual(hiddenMutated);
		expect(Reflect.getOwnPropertyDescriptor(state.held, "locked")).toEqual(lockedMutated);
		expect(Reflect.getOwnPropertyDescriptor(state.held, symbolKey)).toEqual(symbolMutated);
	});
});
