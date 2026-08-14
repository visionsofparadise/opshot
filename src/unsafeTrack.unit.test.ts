import { subscribe } from "./subscribe";
import { transact } from "./transact";
import { createMutableState } from "./createMutableState";
import { ignore } from "./ignore";
import { applyOperations } from "./ops/applyOperations";
import { type Operation } from "./ops/operation";
import { isUnsafeTracked, unsafeTrack, type UnsafeTracked } from "./unsafeTrack";
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
	it("registers a value so isUnsafeTracked reads it, and returns the same reference", () => {
		const value = { x: 1 };
		const tracked = unsafeTrack(value);

		expect(tracked).toBe(value);
		expect(isUnsafeTracked(tracked)).toBe(true);
		expect(isUnsafeTracked(value)).toBe(true);
		expect(isUnsafeTracked({ x: 1 })).toBe(false);
		expect(isUnsafeTracked(null)).toBe(false);
	});

	it("UnsafeTracked<T> types a field in an explicit interface without erasing the marker", () => {
		interface Holder {
			payload: UnsafeTracked<{ x: number }>;
		}

		const payload = unsafeTrack({ x: 1 });
		const holder: Holder = { payload };

		expect(isUnsafeTracked(holder.payload)).toBe(true);
		expect(holder.payload.x).toBe(1);

		// @ts-expect-error a bare T is not UnsafeTracked
		const erased: Holder = { payload: { x: 2 } };

		expect(isUnsafeTracked(erased.payload)).toBe(false);
	});

	it("marks the value tracked without putting it in refSet", () => {
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

		expect(admissionLane(box)).toBe("tracked");
		expect(admissionLane(ignore({ y: 1 }))).toBe("untracked");
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

	it("attaches an unsafeTrack'd #private class; whole-instance undo drops private state", () => {
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
		const heard = recordOwned(state);

		transact(state, () => {
			state.vault.label = "b";
		});

		expect(heard).toHaveLength(1);
		expect(heard[0]?.[0]?.do).toMatchObject({ verb: "assign", path: ["vault", "label"], value: "b" });
		expect(state.vault.label).toBe("b");
		expect(() => state.vault.reveal()).toThrow();
		expect(vault.reveal()).toBe(7);

		heard.length = 0;

		const replacement = unsafeTrack(new Vault());

		transact(state, () => {
			state.vault = replacement;
		});

		expect(heard).toHaveLength(1);

		const replaceOp = heard[0]![0]!;

		expect(replaceOp.do.verb).toBe("assign");
		expect(replaceOp.do.path).toEqual(["vault"]);

		applyOperations(state, [replaceOp], "undo");

		const restored = state.vault;

		expect(restored).toBeInstanceOf(Vault);
		expect(restored.label).toBe("b");
		expect(() => restored.reveal()).toThrow();
	});
});
