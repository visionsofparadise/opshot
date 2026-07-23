import { createBoundary } from "./react/boundary";
import { createGroup } from "./createGroup";
import { createMutableState } from "./createMutableState";
import { isState } from "./isState";
import { subscribe } from "./subscribe";
import { transact } from "./transact";

describe("isState", () => {
	it("recognizes a live state and rejects other values", () => {
		expect(isState(createMutableState({ count: 0 }))).toBe(true);
		expect(isState({ count: 1 })).toBe(false);
		expect(isState({ op: { unsafeMutable: 1 } })).toBe(false);
		expect(isState(null)).toBe(false);
		expect(isState(undefined)).toBe(false);
		expect(isState("state")).toBe(false);
	});

	it("rejects a foreign object shaped like the old handle", () => {
		expect(isState({ op: { unsafeMutable: {} } })).toBe(false);
	});

	it("recognizes a versioned wrapper over a live state", () => {
		const state = createMutableState({ count: 0 });
		const wrapper = createBoundary().wrap(state);

		expect(isState(wrapper)).toBe(true);
		expect(wrapper).not.toBe(state);
	});

	it("keeps isState true on the live object a group subscriber receives", () => {
		const group = createGroup();
		const emissions = new Array<object>();

		subscribe(group, (state) => {
			emissions.push(state);
		});

		const state = group.createState({ count: 0 });

		transact(state, () => {
			state.count = 1;
		});

		expect(emissions[0]).toBe(state);
		expect(isState(emissions[0])).toBe(true);
	});
});
