import { subscribe } from "./subscribe";
import { transact } from "./transact/transact";
import { createMutableState } from "./createMutableState";
import { isSameIdentity } from "./identity";
import { ignore } from "./ignore";
import { type Operation } from "./ops/operation";
import { unsafeTrack, type UnsafeTracked } from "./unsafeTrack";
import { admissionLane } from "./valtio/classify";
import { shapeOps } from "./ops/operationShape";

const recordOwned = <T extends object>(state: T): Array<Array<Operation>> => {
	const heard = new Array<Array<Operation>>();

	subscribe(state, (ops) => {
		heard.push([...ops]);
	});

	return heard;
};

describe("unsafeTrack", () => {
	it("returns the same reference", () => {
		const value = { x: 1 };
		const tracked = unsafeTrack(value);

		expect(tracked).toBe(value);
	});

	it("UnsafeTracked<T> types a field in an explicit interface without erasing the marker", () => {
		interface Holder {
			payload: UnsafeTracked<{ x: number }>;
		}

		const payload = unsafeTrack({ x: 1 });
		const holder: Holder = { payload };

		expect(holder.payload.x).toBe(1);

		// @ts-expect-error a bare T is not UnsafeTracked
		const erased: Holder = { payload: { x: 2 } };

		expect(erased.payload.x).toBe(2);
	});

	it("does not change classify because a wrap is pending", () => {
		class PrivateBox {
			#secret = 1;
			public x = 0;
			reveal() {
				return this.#secret;
			}
		}

		const box = new PrivateBox();

		expect(admissionLane(box)).toBe("dangerous");

		unsafeTrack(box);

		expect(admissionLane(box)).toBe("dangerous");
		expect(admissionLane(ignore({ y: 1 }))).toBe("tracked");
	});
});

describe("unsafeTrack occupancy", () => {
	it("A.foo = unsafeTrack(map) then B.foo = map refuses on strict B", async () => {
		const map = new Map<string, number>();
		const stateA = createMutableState<{ foo: Map<string, number> | null }>({ foo: null });
		const errors = new Array<unknown>();
		const emitOn = (flush: () => void): void => {
			try {
				flush();
			} catch (error) {
				errors.push(error);
			}
		};

		stateA.foo = unsafeTrack(map);
		await Promise.resolve();

		const stateB = createMutableState<{ foo: Map<string, number> | null }>({ foo: null }, { emitOn });

		stateB.foo = map;
		await Promise.resolve();

		expect(isSameIdentity(stateA.foo, map)).toBe(true);
		expect(stateB.foo).toBe(map);
		expect(errors[0]).toBeInstanceOf(Error);
		expect(String(errors[0])).toContain("Map at /foo cannot be tracked");
	});

	it("leave-and-return needs a new wrap", async () => {
		const map = new Map<string, number>();
		const errors = new Array<unknown>();
		const state = createMutableState<{ foo: Map<string, number> | unknown }>(
			{ foo: null },
			{
				emitOn: (flush) => {
					try {
						flush();
					} catch (error) {
						errors.push(error);
					}
				},
			},
		);

		state.foo = unsafeTrack(map);
		await Promise.resolve();
		expect(errors).toHaveLength(0);

		state.foo = { n: 1 };
		await Promise.resolve();
		expect(errors).toHaveLength(0);

		state.foo = map;
		await Promise.resolve();

		expect(errors).toHaveLength(1);
		expect(String(errors[0])).toContain("Map at /foo cannot be tracked");

		errors.length = 0;
		state.foo = unsafeTrack(map);
		await Promise.resolve();

		expect(errors).toHaveLength(0);
		expect(typeof state.foo === "object" && state.foo !== null && isSameIdentity(state.foo, map)).toBe(true);
	});

	it("same-window overwrite of an unsafe wrap then a later assign without a wrap refuses", async () => {
		const map = new Map<string, number>();
		const errors = new Array<unknown>();
		const state = createMutableState<{ foo: Map<string, number> | unknown }>(
			{ foo: null },
			{
				emitOn: (flush) => {
					try {
						flush();
					} catch (error) {
						errors.push(error);
					}
				},
			},
		);

		state.foo = unsafeTrack(map);
		state.foo = { n: 1 };
		await Promise.resolve();
		expect(errors).toHaveLength(0);

		state.foo = map;
		await Promise.resolve();

		expect(errors).toHaveLength(1);
		expect(String(errors[0])).toContain("Map at /foo cannot be tracked");
	});

	it("delete after an unsafe wrap then a later assign without a wrap refuses", async () => {
		const map = new Map<string, number>();
		const errors = new Array<unknown>();
		const state = createMutableState<{ foo?: Map<string, number> | unknown }>(
			{ foo: null },
			{
				emitOn: (flush) => {
					try {
						flush();
					} catch (error) {
						errors.push(error);
					}
				},
			},
		);

		state.foo = unsafeTrack(map);
		delete state.foo;
		await Promise.resolve();
		expect(errors).toHaveLength(0);

		state.foo = map;
		await Promise.resolve();

		expect(errors).toHaveLength(1);
		expect(String(errors[0])).toContain("Map at /foo cannot be tracked");
	});

	it("wrap then subscribe in the same turn then leave-and-return without a wrap refuses", async () => {
		const map = new Map<string, number>();
		const errors = new Array<unknown>();
		const state = createMutableState<{ foo: Map<string, number> | unknown }>(
			{ foo: null },
			{
				emitOn: (flush) => {
					try {
						flush();
					} catch (error) {
						errors.push(error);
					}
				},
			},
		);

		state.foo = unsafeTrack(map);
		subscribe(state, () => undefined);
		await Promise.resolve();
		expect(errors).toHaveLength(0);

		state.foo = { n: 1 };
		await Promise.resolve();
		expect(errors).toHaveLength(0);

		state.foo = map;
		await Promise.resolve();

		expect(errors).toHaveLength(1);
		expect(String(errors[0])).toContain("Map at /foo cannot be tracked");
	});
});

describe("unsafeTrack stories", () => {
	it("tracks public data on a clean-arrow class; arrow-method writes are not recorded", () => {
		class Arrow {
			count = 0;
			bump = (): void => {
				this.count += 1;
			};
		}

		const arrow = unsafeTrack(new Arrow());
		const state = createMutableState({ arrow });
		const heard = recordOwned(state);

		transact(state, () => {
			state.arrow.count = 5;
		});

		expect(heard).toHaveLength(1);
		expect(shapeOps(heard[0] ?? [])).toEqual([
			{
				do: { verb: "assign", path: ["arrow", "count"], value: 5 },
				undo: { verb: "assign", path: ["arrow", "count"], value: 0 },
			},
		]);
		expect(state.arrow.count).toBe(5);

		heard.length = 0;

		transact(state, () => {
			state.arrow.bump();
		});

		expect(heard).toHaveLength(0);
		expect(arrow.count).toBe(6);
	});

	it("attaches an unsafeTrack'd #private class and writes public fields", () => {
		class Vault {
			#secret = 7;
			public label = "a";

			reveal(): number {
				return this.#secret;
			}
		}

		const vault = unsafeTrack(new Vault());

		expect(vault.reveal()).toBe(7);

		const state = createMutableState({ vault });

		transact(state, () => {
			state.vault.label = "b";
		});

		expect(state.vault.label).toBe("b");
		expect(() => state.vault.reveal()).toThrow();
		expect(vault.reveal()).toBe(7);
	});
});
