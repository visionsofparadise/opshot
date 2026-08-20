import { transact } from "../transact/transact";
import { createMutableState } from "../createMutableState";

describe("boundaryErrors: rejection vocabulary", () => {
	it("throws for a Map in the define literal", () => {
		expect(() => createMutableState({ lookup: new Map<string, number>() })).toThrow(
			"opshot: Map at /lookup cannot be tracked",
		);
	});

	it("throws from transact on a dangerous assign, leaving the state unchanged", () => {
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
});
