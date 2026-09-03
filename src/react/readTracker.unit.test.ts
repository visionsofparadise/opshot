import { createMutableState } from "../createMutableState";
import { createReadTracker, readsChanged } from "./readTracker";

describe("§6.1 reads", () => {
	it("records a get key so a later write to it is a changed read", () => {
		const state = createMutableState({ count: 0, extra: 1 });
		const tracker = createReadTracker();
		const read = tracker.wrap(state);

		void read.count;

		expect(readsChanged(tracker)).toBe(false);

		state.extra = 2;

		expect(readsChanged(tracker)).toBe(false);

		state.count = 1;

		expect(readsChanged(tracker)).toBe(true);
	});

	it("records a has key", () => {
		const state = createMutableState({ count: 0 } as { count: number; extra?: number });
		const tracker = createReadTracker();
		const read = tracker.wrap(state);

		expect("extra" in read).toBe(false);

		expect(readsChanged(tracker)).toBe(false);

		state.extra = 1;

		expect(readsChanged(tracker)).toBe(true);
	});

	it("records a getOwnPropertyDescriptor key", () => {
		const state = createMutableState({ count: 0 } as { count: number; extra?: number });
		const tracker = createReadTracker();
		const read = tracker.wrap(state);

		void Object.getOwnPropertyDescriptor(read, "extra");

		expect(readsChanged(tracker)).toBe(false);

		state.extra = 1;

		expect(readsChanged(tracker)).toBe(true);
	});

	it("records an ownKeys list", () => {
		const state = createMutableState({ count: 0 } as { count: number; extra?: number });
		const tracker = createReadTracker();
		const read = tracker.wrap(state);

		void Object.keys(read);

		expect(readsChanged(tracker)).toBe(false);

		state.extra = 1;

		expect(readsChanged(tracker)).toBe(true);
	});
});

describe("readsChanged", () => {
	it("reports a changed value", () => {
		const state = createMutableState({ count: 0 });
		const tracker = createReadTracker();
		const read = tracker.wrap(state);

		void read.count;
		state.count = 1;

		expect(readsChanged(tracker)).toBe(true);
	});

	it("reports an unchanged value as false", () => {
		const state = createMutableState({ count: 0 });
		const tracker = createReadTracker();
		const read = tracker.wrap(state);

		void read.count;

		expect(readsChanged(tracker)).toBe(false);
	});

	it("reports a changed ownKeys list", () => {
		const state = createMutableState({ count: 0 } as { count: number; extra?: number });
		const tracker = createReadTracker();
		const read = tracker.wrap(state);

		void Object.keys(read);
		state.extra = 1;

		expect(readsChanged(tracker)).toBe(true);
	});

	it("reports a has flip", () => {
		const state = createMutableState({ count: 0 } as { count: number; extra?: number });
		const tracker = createReadTracker();
		const read = tracker.wrap(state);

		expect("extra" in read).toBe(false);
		state.extra = 1;

		expect(readsChanged(tracker)).toBe(true);
	});
});
