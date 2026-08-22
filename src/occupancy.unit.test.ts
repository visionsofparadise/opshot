import { createMutableState } from "./createMutableState";
import { edgeStatusOf } from "./edges";
import { handleOf } from "./handle";
import { internedIdOf } from "./intern";
import { createCaptureTables, syncHandleTables } from "./occupancy";
import { unsafeTrack } from "./unsafeTrack";

describe("occupancy re-sync", () => {
	it("re-syncing an admitted-unsafe node keeps its intern id and occupancy", () => {
		const map = new Map<string, number>([["k", 1]]);
		const state = createMutableState({ box: unsafeTrack(map) });
		const handle = handleOf(state);

		expect(handle).toBeDefined();

		const internId = internedIdOf(handle!, map);

		expect(internId).toBeDefined();
		expect(edgeStatusOf(handle!, map).occupied).toBe(true);

		const capture = createCaptureTables();

		syncHandleTables(handle!, capture);

		expect(internedIdOf(handle!, map)).toBe(internId);
		expect(edgeStatusOf(handle!, map).occupied).toBe(true);
		expect(state.box).toBeInstanceOf(Map);
	});
});
