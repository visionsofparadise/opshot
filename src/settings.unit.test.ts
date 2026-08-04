import { unstable_getInternalStates } from "valtio/vanilla";
import { createGroup } from "./createGroup";
import { createMutableState } from "./createMutableState";
import { getOptions, inheritOptions, stampOptions, type EmissionScheduler } from "./settings";

const { proxyStateMap } = unstable_getInternalStates();

const target = (writeProxy: object): object => {
	const entry = proxyStateMap.get(writeProxy);

	if (entry === undefined) throw new Error("expected a proxied target");

	return entry[0];
};

describe("options table", () => {
	it("round-trips a stamp through getOptions", () => {
		const target = {};
		const emitOn: EmissionScheduler = (flush) => {
			flush();
		};

		stampOptions(target, { emitOn, strict: false });

		expect(getOptions(target)).toEqual({ emitOn, strict: false });
	});

	it("stores nothing when both emitOn and strict are undefined", () => {
		const target = {};

		stampOptions(target, {});
		stampOptions(target, undefined);

		expect(getOptions(target)).toBeUndefined();
	});

	it("leaves no entry when createMutableState is called with only a group", () => {
		const group = createGroup();
		const state = createMutableState({ count: 0 }, { group });

		expect(getOptions(target(state))).toBeUndefined();
	});

	it("stores only the defined fields", () => {
		const withEmit: EmissionScheduler = (flush) => {
			flush();
		};
		const emitOnly = {};
		const strictOnly = {};

		stampOptions(emitOnly, { emitOn: withEmit });
		stampOptions(strictOnly, { strict: false });

		expect(getOptions(emitOnly)).toEqual({ emitOn: withEmit });
		expect(getOptions(strictOnly)).toEqual({ strict: false });
	});

	it("inheritOptions copies the parent's reference onto the child", () => {
		const parent = {};
		const child = {};
		const emitOn: EmissionScheduler = (flush) => {
			flush();
		};

		stampOptions(parent, { emitOn, strict: false });
		inheritOptions(parent, child);

		expect(getOptions(child)).toBe(getOptions(parent));
	});

	it("inheritOptions returns without writing when the parent has no entry", () => {
		const parent = {};
		const child = {};

		inheritOptions(parent, child);

		expect(getOptions(child)).toBeUndefined();
	});

	it("inheritOptions returns without writing when the child is a proxyStateMap member", () => {
		const parent = {};
		const emitOn: EmissionScheduler = (flush) => {
			flush();
		};

		stampOptions(parent, { emitOn });

		const moved = createMutableState({ nested: { value: 1 } });

		expect(proxyStateMap.has(moved)).toBe(true);

		inheritOptions(parent, moved);

		expect(getOptions(target(moved))).toBeUndefined();
		expect(getOptions(moved)).toBeUndefined();
	});
});

describe("options inheritance through the boundary", () => {
	it("reaches an arbitrarily deep nested initializer", () => {
		const emitOn: EmissionScheduler = (flush) => {
			flush();
		};
		const state = createMutableState(
			{
				a: {
					b: {
						c: { value: 1 },
					},
				},
			},
			{ emitOn, strict: false },
		);

		const rootOptions = getOptions(target(state));
		const grandchildOptions = getOptions(target(state.a.b.c));

		expect(rootOptions).toEqual({ emitOn, strict: false });
		expect(grandchildOptions).toBe(rootOptions);
	});

	it("reaches a subtree assigned after creation", () => {
		const emitOn: EmissionScheduler = (flush) => {
			flush();
		};
		const state = createMutableState(
			{
				holder: {} as { nested: { value: number } },
			},
			{ emitOn },
		);

		state.holder = { nested: { value: 2 } };

		const rootOptions = getOptions(target(state));
		const nestedOptions = getOptions(target(state.holder.nested));

		expect(nestedOptions).toBe(rootOptions);
	});

	it("leaves no entry on an unconfigured state or its children", () => {
		const state = createMutableState({
			a: {
				b: { value: 1 },
			},
		});

		expect(getOptions(target(state))).toBeUndefined();
		expect(getOptions(target(state.a))).toBeUndefined();
		expect(getOptions(target(state.a.b))).toBeUndefined();
	});

	it("leaves a moved subtree its origin options", () => {
		const emitA: EmissionScheduler = (flush) => {
			flush();
		};
		const emitB: EmissionScheduler = (flush) => {
			flush();
		};
		const source = createMutableState({ box: { value: 1 } }, { emitOn: emitA });
		const destination = createMutableState({ box: {} as { value: number } }, { emitOn: emitB });
		const moved = source.box;

		destination.box = moved;

		expect(getOptions(target(destination.box))).toBe(getOptions(target(source)));
		expect(getOptions(target(destination.box))?.emitOn).toBe(emitA);
	});
});
