import { transact } from "../transact";
import { createMutableState } from "../createMutableState";
import { rejectionError } from "./boundaryErrors";

describe("boundaryErrors: rejection vocabulary", () => {
	it("omits the location clause with no path, the form canProxy raises", () => {
		const locationless =
			"opshot: Map cannot be tracked (its state lives in internal slots). Options:\n- use TrackedMap for a tracked equivalent\n- unsafeTrack(value) to track it lossily\n- ignore(value) to store it by reference, untracked";

		expect(rejectionError(new Map<string, number>(), "nativeClass").message).toBe(locationless);
		expect(rejectionError(new Map<string, number>(), "nativeClass", []).message).toBe(locationless);
		expect(rejectionError(new Map<string, number>(), "nativeClass", ["a", "b"]).message).toContain(
			"opshot: Map at /a/b cannot be tracked",
		);
	});

	it("throws for a Map in the define literal, naming TrackedMap, unsafeTrack, and ignore", () => {
		expect(() => createMutableState({ lookup: new Map<string, number>() })).toThrow(
			"opshot: Map at /lookup cannot be tracked (its state lives in internal slots). Options:\n- use TrackedMap for a tracked equivalent\n- unsafeTrack(value) to track it lossily\n- ignore(value) to store it by reference, untracked",
		);
	});

	it("throws for a Set, naming TrackedSet, unsafeTrack, and ignore", () => {
		expect(() => createMutableState({ members: new Set<string>() })).toThrow(
			"opshot: Set at /members cannot be tracked (its state lives in internal slots). Options:\n- use TrackedSet for a tracked equivalent\n- unsafeTrack(value) to track it lossily\n- ignore(value) to store it by reference, untracked",
		);
	});

	it("throws for a Date, naming TrackedDate, unsafeTrack, and ignore", () => {
		expect(() => createMutableState({ createdAt: new Date() })).toThrow(
			"opshot: Date at /createdAt cannot be tracked (its state lives in internal slots). Options:\n- use TrackedDate for a tracked equivalent\n- unsafeTrack(value) to track it lossily\n- ignore(value) to store it by reference, untracked",
		);
	});

	it("throws for an offending value nested inside the define literal", () => {
		expect(() => createMutableState({ outer: { m: new Map<string, number>() } })).toThrow(
			"opshot: Map at /outer/m cannot be tracked",
		);
	});

	it("throws at the assigning line inside mutate, leaving the state unchanged", () => {
		interface Box {
			box: unknown;
		}

		const state = createMutableState<Box>({ box: null });

		expect(() => {
			transact(state, () => {
				state.box = new Map<string, number>();
			});
		}).toThrow("opshot: Map at /box cannot be tracked");

		expect(state.box).toBe(null);
	});

	it("throws for a private-field class, naming unsafeTrack and ignore", () => {
		class Vault {
			#combination = 7;

			read() {
				return this.#combination;
			}
		}

		expect(() => createMutableState({ vault: new Vault() })).toThrow(
			"opshot: Vault at /vault cannot be tracked (its state is hidden in private fields). Options:\n- unsafeTrack(value) tracks public fields while private methods throw on snapshots and undo drops that state\n- ignore(value) to store it by reference, untracked",
		);
	});

	it("throws for a Map subclass with the facade-led message under its own name", () => {
		class Cache extends Map<string, number> {}

		expect(() => createMutableState({ cache: new Cache() })).toThrow(
			"opshot: Cache at /cache cannot be tracked (its state lives in internal slots). Options:\n- use TrackedMap for a tracked equivalent\n- unsafeTrack(value) to track it lossily\n- ignore(value) to store it by reference, untracked",
		);
	});

	it("throws for an array subclass instead of silently demoting it", () => {
		class Stack extends Array<number> {}

		expect(() => createMutableState({ stack: new Stack() })).toThrow(
			"opshot: Stack at /stack cannot be tracked (array subclasses lose their prototype in snapshots). Options:\n- unsafeTrack(value) to track its data anyway\n- ignore(value) to store it by reference, untracked",
		);
	});

	it("throws for a clean class with an own-enumerable arrow method, naming unsafeTrack", () => {
		class Arrow {
			count = 0;
			bump = (): void => {
				this.count += 1;
			};
		}

		expect(() => createMutableState({ arrow: new Arrow() })).toThrow(
			"opshot: Arrow at /arrow cannot be tracked (arrow-method writes won't be tracked). Options:\n- unsafeTrack(value) to track its data anyway\n- ignore(value) to store it by reference, untracked",
		);
	});

	it("throws for a frozen Map: freezing does not freeze internal slots", () => {
		expect(() => createMutableState({ lookup: Object.freeze(new Map<string, number>()) })).toThrow(
			"opshot: Map at /lookup cannot be tracked",
		);
	});
});
