import { createMutableState } from "./createMutableState";
import { handleOf } from "./handle";
import { createCaptureTables, predatingRoutesOf, syncHandleTables } from "./occupancy";
import { unsafeTrack } from "./unsafeTrack";

describe("occupancy re-sync", () => {
	it("re-syncing an admitted-unsafe node collects no second refusal", () => {
		const map = new Map<string, number>([["k", 1]]);
		const state = createMutableState({ box: unsafeTrack(map) });
		const handle = handleOf(state);

		expect(handle).toBeDefined();

		const routes = predatingRoutesOf(handle!, map);

		expect(routes.length).toBeGreaterThan(0);

		const capture = createCaptureTables();

		syncHandleTables(handle!, capture);

		expect(capture.refusals).toEqual([]);
		expect(predatingRoutesOf(handle!, map)).toEqual(routes);
		expect(state.box).toBeInstanceOf(Map);
	});
});
