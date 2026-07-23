import { createState, type State } from "./createState";
import { ignore } from "./ignore";
import { applyOps } from "./ops/applyOps";
import type { Op } from "./ops/operation";
import { isUnsafeTracked, unsafeTrack, type UnsafeTracked } from "./unsafeTrack";
import { isTrackable } from "./valtio/classify";

const recordOwned = <T extends object>(state: State<T>): Array<Array<Op>> => {
	const heard = new Array<Array<Op>>();

	state.op.subscribe((_state, ops, emission) => {
		if (!emission.isSideEffect) heard.push(ops);
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

	it("marks the value trackable without putting it in refSet", () => {
		class PrivateBox {
			#secret = 1;
			public x = 0;
			reveal() {
				return this.#secret;
			}
		}

		const box = new PrivateBox();

		expect(isTrackable(box)).toBe(false);

		unsafeTrack(box);

		expect(isTrackable(box)).toBe(true);
		expect(isTrackable(ignore({ y: 1 }))).toBe(false);
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
		const state = createState({ arrow });
		const heard = recordOwned(state);

		state.mutate((mutable) => {
			mutable.arrow.count = 5;
		});

		expect(heard).toHaveLength(1);
		expect(heard[0]).toEqual([
			{
				do: { op: "replace", path: ["arrow", "count"], value: 5 },
				undo: { op: "replace", path: ["arrow", "count"], value: 0 },
			},
		]);
		expect(state.op.unwrap().arrow.count).toBe(5);

		heard.length = 0;

		state.mutate((mutable) => {
			mutable.arrow.bump();
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

		const state = createState({ vault });
		const heard = recordOwned(state);

		state.mutate((mutable) => {
			mutable.vault.label = "b";
		});

		expect(heard).toHaveLength(1);
		expect(heard[0]?.[0]?.do).toMatchObject({ op: "replace", path: ["vault", "label"], value: "b" });
		expect(state.op.unwrap().vault.label).toBe("b");
		expect(() => state.op.unwrap().vault.reveal()).toThrow();
		expect(vault.reveal()).toBe(7);

		heard.length = 0;

		const replacement = unsafeTrack(new Vault());

		state.mutate((mutable) => {
			mutable.vault = replacement;
		});

		expect(heard).toHaveLength(1);

		const replaceOp = heard[0]![0]!;

		expect(replaceOp.do.op).toBe("replace");
		expect(replaceOp.do.path).toEqual(["vault"]);

		applyOps(state, [replaceOp.undo]);

		const restored = state.op.unwrap().vault;

		expect(restored).toBeInstanceOf(Vault);
		expect(restored.label).toBe("b");
		expect(() => restored.reveal()).toThrow();
	});
});
