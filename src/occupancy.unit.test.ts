import { createMutableState } from "./createMutableState";
import { handleOf } from "./handle";
import { internedIdOf } from "./intern";
import { internedOccupied } from "./ops/internedOccupancy";
import { unsafeTrack } from "./unsafeTrack";

describe("occupancy re-sync", () => {
	it("an admitted-unsafe node keeps its intern id without an in-edge", () => {
		const map = new Map<string, number>([["k", 1]]);
		const state = createMutableState({ box: unsafeTrack(map) });
		const handle = handleOf(state);

		expect(handle).toBeDefined();

		const internId = internedIdOf(handle!, map);

		expect(internId).toBeDefined();
		expect(internedOccupied(handle!, map)).toBe(false);
		expect(internedIdOf(handle!, map)).toBe(internId);
		expect(state.box).toBeInstanceOf(Map);
	});
});
