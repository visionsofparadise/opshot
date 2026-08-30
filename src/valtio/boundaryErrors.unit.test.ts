import { batch } from "../batch";
import { createMutableState } from "../createMutableState";

describe("boundaryErrors: rejection vocabulary", () => {
	it("throws for a Map in the define literal", () => {
		expect(() => createMutableState({ lookup: new Map<string, number>() })).toThrow(
			"opshot: Map at /lookup cannot be tracked",
		);
	});

	it("throws from batch on a dangerous assign, leaving the state unchanged", () => {
		interface Box {
			box: unknown;
		}

		const state = createMutableState<Box>({ box: null });

		expect(() => {
			batch(() => {
				state.box = new Map<string, number>();
			});
		}).toThrow("opshot: Map at /box cannot be tracked");

		expect(state.box).toBe(null);
	});

	it("throws for a private-field class", () => {
		class Vault {
			#combination = 7;

			read() {
				return this.#combination;
			}
		}

		expect(() => createMutableState({ vault: new Vault() })).toThrow("opshot: Vault at /vault cannot be tracked");
	});

	it("throws for a clean class with an own-enumerable arrow method", () => {
		class Arrow {
			count = 0;
			bump = (): void => {
				this.count += 1;
			};
		}

		expect(() => createMutableState({ arrow: new Arrow() })).toThrow(
			"opshot: Arrow at /arrow/bump cannot be tracked",
		);
	});

	it("holds a frozen Map as that node", () => {
		const frozenMap = Object.freeze(new Map<string, number>());
		const state = createMutableState({ lookup: frozenMap });

		expect(state.lookup).toBe(frozenMap);
	});

	it.each([
		{ kind: "Set", key: "members", create: () => new Set<string>(), facade: "TrackedSet" },
		{ kind: "Date", key: "createdAt", create: () => new Date(), facade: "TrackedDate" },
	] as const)("throws for a live $kind naming $facade, unsafeTrack, and ignore", ({ kind, key, create, facade }) => {
		expect(() => createMutableState({ [key]: create() })).toThrow(
			`opshot: ${kind} at /${key} cannot be tracked (its state lives in internal slots). Options:\n- use ${facade} for a tracked equivalent\n- unsafeTrack(value) to track it lossily\n- ignore(value) to store it by reference, untracked`,
		);
	});

	it("throws for an array subclass instead of silently demoting it", () => {
		class Stack extends Array<number> {}

		expect(() => createMutableState({ stack: new Stack() })).toThrow(
			"opshot: Stack at /stack cannot be tracked (array subclasses lose their prototype in snapshots). Options:\n- unsafeTrack(value) to track its data anyway\n- ignore(value) to store it by reference, untracked",
		);
	});

	it("throws for a native-slot class under its own constructor name", () => {
		expect(() => createMutableState({ box: new WeakMap() })).toThrow(
			"opshot: WeakMap at /box cannot be tracked (its state is hidden in internal slots). Options:\n- unsafeTrack(value) tracks public fields while slot methods throw on snapshots and undo drops that state\n- ignore(value) to store it by reference, untracked",
		);
	});
});
