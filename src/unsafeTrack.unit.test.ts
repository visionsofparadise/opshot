import { transact } from "./transact/transact";
import { createMutableState } from "./createMutableState";
import { isSameIdentity } from "./identity";
import { unsafeTrack } from "./unsafeTrack";

describe("unsafeTrack occupancy", () => {
	it("A.foo = unsafeTrack(map) then B.foo = map refuses on strict B", () => {
		const map = new Map<string, number>();
		const stateA = createMutableState<{ foo: Map<string, number> | null }>({ foo: null });

		transact(stateA, () => {
			stateA.foo = unsafeTrack(map);
		});

		const stateB = createMutableState<{ foo: Map<string, number> | null }>({ foo: null });

		expect(() => {
			transact(stateB, () => {
				stateB.foo = map;
			});
		}).toThrow("Map at /foo cannot be tracked");

		expect(isSameIdentity(stateA.foo, map)).toBe(true);
		expect(stateB.foo).toBe(null);
	});

	it("leave-and-return needs a new wrap", () => {
		const map = new Map<string, number>();
		const state = createMutableState<{ foo: Map<string, number> | unknown }>({ foo: null });

		transact(state, () => {
			state.foo = unsafeTrack(map);
		});

		transact(state, () => {
			state.foo = { n: 1 };
		});

		expect(() => {
			transact(state, () => {
				state.foo = map;
			});
		}).toThrow("Map at /foo cannot be tracked");

		transact(state, () => {
			state.foo = unsafeTrack(map);
		});

		expect(typeof state.foo === "object" && state.foo !== null && isSameIdentity(state.foo, map)).toBe(true);
	});
});
