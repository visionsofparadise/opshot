import { transact } from "./transact/transact";
import { createMutableState } from "./createMutableState";
import { isSameIdentity } from "./identity";
import { unsafeMarker, unsafeTrack } from "./unsafeTrack";

describe("unsafeTrack occupancy", () => {
	it("keeps a create-time unsafe path admitted across reassignment", () => {
		const first = new Map<string, number>([["a", 1]]);
		const second = new Map<string, number>([["b", 2]]);
		const state = createMutableState({ foo: unsafeTrack(first) });

		transact(state, () => {
			state.foo = second;
		});

		expect(isSameIdentity(state.foo, second)).toBe(true);
	});

	it("admits a dangerous value nested under an unsafe boundary", () => {
		const nested = new Map<string, number>([["k", 1]]);
		const state = createMutableState({ box: unsafeTrack({ nested }) });

		expect(isSameIdentity(state.box.nested, nested)).toBe(true);

		const next = new Map<string, number>([["k", 2]]);

		transact(state, () => {
			state.box.nested = next;
		});

		expect(isSameIdentity(state.box.nested, next)).toBe(true);
	});

	it("throws at the cause when a dangerous value sits outside an unsafe boundary", () => {
		expect(() => createMutableState({ safe: unsafeTrack({ n: 1 }), map: new Map<string, number>() })).toThrow(
			"Map at /map cannot be tracked",
		);
	});

	it("lands a live unsafeTrack() assignment as a ride-along-bearing object", () => {
		const map = new Map<string, number>();
		const state = createMutableState<{ foo: unknown }>({ foo: null });

		transact(state, () => {
			state.foo = unsafeTrack(map);
		});

		expect(state.foo).not.toBe(map);
		expect(typeof state.foo === "object" && state.foo !== null && Object.hasOwn(state.foo, unsafeMarker)).toBe(true);
	});
});
