import { createMutableState } from "../createMutableState";
import { TrackedMap } from "./trackedMap";

describe("§2.2 assigning a node into a state it currently occupies keeps its identity in that state", () => {
	it("addresses the same object as raw and as the proxy the state returns", () => {
		const key = { id: 1 };
		const state = createMutableState({
			map: new TrackedMap<object, string>([[key, "held"]]),
			key,
		});

		expect(state.map.get(key)).toBe("held");
		expect(state.map.get(state.key)).toBe("held");
		expect(state.map.has(state.key)).toBe(true);
	});
});
