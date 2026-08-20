import { snapshot } from "valtio/vanilla";
import { createMutableState } from "../createMutableState";

describe("snapshotAccessors: freeze occupancy", () => {
	it("carries a live-frozen child by reference like an admission-time freeze", () => {
		const state = createMutableState({ child: { n: 1 } });

		Object.freeze(state.child);

		expect(snapshot(state).child).toBe(state.child);

		const frozen = Object.freeze({ n: 1 });

		expect(snapshot(createMutableState({ child: frozen })).child).toBe(frozen);
	});
});
