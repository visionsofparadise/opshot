import { createMutableState } from "./createMutableState";
import { identify, isSameIdentity } from "./identity";
import { createReadTracker } from "./react/readTracker";

describe("§2.2 assigning a node into a state it currently occupies keeps its identity in that state", () => {
	it("identify and isSameIdentity treat a node and its proxy as one", () => {
		const raw = { value: 1 };
		const state = createMutableState({ item: raw });

		expect(isSameIdentity(raw, state.item)).toBe(true);
		expect(identify(raw)).toBe(identify(state.item));
		expect(state.item).not.toBe(raw);
	});

	it("two distinct nodes stay distinct", () => {
		const first = createMutableState({ value: 1 });
		const second = createMutableState({ value: 1 });

		expect(isSameIdentity(first, second)).toBe(false);
		expect(identify(first)).not.toBe(identify(second));
	});

	it("a read proxy peels to the same identity as the write proxy", () => {
		const state = createMutableState({ count: 0 });
		const read = createReadTracker().wrap(state);

		expect(read).not.toBe(state);
		expect(isSameIdentity(state, read)).toBe(true);
		expect(identify(state)).toBe(identify(read));
	});
});
