import { createMutableState } from "../createMutableState";
import { identify, isSameIdentity } from "../identity";
import { ignore } from "../ignore";
import { applyOperations } from "../ops/applyOperations";
import { type Operation } from "../ops/operation";
import { subscribe } from "../subscribe";
import { transact } from "../transact/transact";
import { TrackedSet } from "./trackedSet";

const record = <T extends object>(state: T): Array<Array<Operation>> => {
	const heard = new Array<Array<Operation>>();

	subscribe(state, (ops) => heard.push([...ops]));

	return heard;
};

describe("TrackedSet", () => {
	it("preserves member identity through remove and restore", () => {
		const member = { id: 1 };
		const selection = new Map([[identify(member), "selected"]]);
		const state = createMutableState({ set: new TrackedSet([member]) });
		const heard = record(state);

		transact(state, () => state.set.delete(member));
		const ops = heard[0] ?? [];
		applyOperations(state, ops, "undo");

		const restored = [...state.set][0];

		expect(restored && selection.get(identify(restored))).toBe("selected");
		expect(restored && isSameIdentity(restored, member)).toBe(true);
	});

	it("keeps an ignored member by reference and silent on its interior writes", () => {
		class Point {
			x = 1;
		}

		const member = new Point();
		const state = createMutableState({ set: ignore(new TrackedSet([member])) });
		const heard = record(state);
		const held = [...state.set][0];

		expect(held).toBe(member);

		transact(state, () => {
			const current = [...state.set][0];

			if (typeof current !== "object" || current === null) throw new Error("missing member");

			(current as { x: number }).x = 2;
		});

		expect(heard).toHaveLength(0);
		expect([...state.set][0]).toBe(member);
		expect(member.x).toBe(2);
	});
});
