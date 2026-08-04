import { unstable_getInternalStates } from "valtio/vanilla";
import { createGroup } from "./createGroup";
import { createMutableState } from "./createMutableState";
import { getSettings, inheritSettings, stampSettings, type EmitOn } from "./settings";

const { proxyStateMap } = unstable_getInternalStates();

const target = (writeProxy: object): object => {
	const entry = proxyStateMap.get(writeProxy);

	if (entry === undefined) throw new Error("expected a proxied target");

	return entry[0];
};

describe("settings table", () => {
	it("round-trips a stamp through getSettings", () => {
		const target = {};
		const emitOn: EmitOn = (flush) => {
			flush();
		};

		stampSettings(target, { emitOn, strict: false });

		expect(getSettings(target)).toEqual({ emitOn, strict: false });
	});

	it("stores nothing when both emitOn and strict are undefined", () => {
		const target = {};

		stampSettings(target, {});
		stampSettings(target, undefined);

		expect(getSettings(target)).toBeUndefined();
	});

	it("leaves no entry when createMutableState is called with only a group", () => {
		const group = createGroup();
		const state = createMutableState({ count: 0 }, { group });

		expect(getSettings(target(state))).toBeUndefined();
	});

	it("stores only the defined fields", () => {
		const withEmit: EmitOn = (flush) => {
			flush();
		};
		const emitOnly = {};
		const strictOnly = {};

		stampSettings(emitOnly, { emitOn: withEmit });
		stampSettings(strictOnly, { strict: false });

		expect(getSettings(emitOnly)).toEqual({ emitOn: withEmit });
		expect(getSettings(strictOnly)).toEqual({ strict: false });
	});

	it("inheritSettings copies the parent's reference onto the child", () => {
		const parent = {};
		const child = {};
		const emitOn: EmitOn = (flush) => {
			flush();
		};

		stampSettings(parent, { emitOn, strict: false });
		inheritSettings(parent, child);

		expect(getSettings(child)).toBe(getSettings(parent));
	});

	it("inheritSettings returns without writing when the parent has no entry", () => {
		const parent = {};
		const child = {};

		inheritSettings(parent, child);

		expect(getSettings(child)).toBeUndefined();
	});

	it("inheritSettings returns without writing when the child is a proxyStateMap member", () => {
		const parent = {};
		const emitOn: EmitOn = (flush) => {
			flush();
		};

		stampSettings(parent, { emitOn });

		const moved = createMutableState({ nested: { value: 1 } });

		expect(proxyStateMap.has(moved)).toBe(true);

		inheritSettings(parent, moved);

		expect(getSettings(target(moved))).toBeUndefined();
		expect(getSettings(moved)).toBeUndefined();
	});
});

describe("settings inheritance through the boundary", () => {
	it("reaches an arbitrarily deep nested initializer", () => {
		const emitOn: EmitOn = (flush) => {
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

		const rootSettings = getSettings(target(state));
		const grandchildSettings = getSettings(target(state.a.b.c));

		expect(rootSettings).toEqual({ emitOn, strict: false });
		expect(grandchildSettings).toBe(rootSettings);
	});

	it("reaches a subtree assigned after creation", () => {
		const emitOn: EmitOn = (flush) => {
			flush();
		};
		const state = createMutableState(
			{
				holder: {} as { nested: { value: number } },
			},
			{ emitOn },
		);

		state.holder = { nested: { value: 2 } };

		const rootSettings = getSettings(target(state));
		const nestedSettings = getSettings(target(state.holder.nested));

		expect(nestedSettings).toBe(rootSettings);
	});

	it("leaves no entry on an unconfigured state or its children", () => {
		const state = createMutableState({
			a: {
				b: { value: 1 },
			},
		});

		expect(getSettings(target(state))).toBeUndefined();
		expect(getSettings(target(state.a))).toBeUndefined();
		expect(getSettings(target(state.a.b))).toBeUndefined();
	});

	it("leaves a moved subtree its origin settings", () => {
		const emitA: EmitOn = (flush) => {
			flush();
		};
		const emitB: EmitOn = (flush) => {
			flush();
		};
		const source = createMutableState({ box: { value: 1 } }, { emitOn: emitA });
		const destination = createMutableState({ box: {} as { value: number } }, { emitOn: emitB });
		const moved = source.box;

		destination.box = moved;

		expect(getSettings(target(destination.box))).toBe(getSettings(target(source)));
		expect(getSettings(target(destination.box))?.emitOn).toBe(emitA);
	});
});
