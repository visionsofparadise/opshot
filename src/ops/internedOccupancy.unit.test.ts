import { createMutableState } from "../createMutableState";
import { edgeStatusOf } from "../edges";
import { requireHandle } from "../handle";
import { internedIdOf, stageVend } from "../intern";
import { createCaptureTables } from "../occupancy";
import { interiorReachesInternedOccupied, internedOccupied, liveOf, occupancyNodeOf } from "./internedOccupancy";

describe("internedOccupancy", () => {
	it("hits a directly interned-occupied node", () => {
		const state = createMutableState({ box: { n: 1 } });
		const handle = requireHandle(state, "opshot: test requires a state");

		expect(liveOf(state.box)).toBe(state.box);
		expect(occupancyNodeOf(state.box)).not.toBe(state.box);
		expect(internedOccupied(handle, state.box)).toBe(true);
		expect(internedIdOf(handle, occupancyNodeOf(state.box))).toBeDefined();
	});

	it("hits a nested interned-occupied descendant", () => {
		const state = createMutableState({ box: { inner: { n: 1 } } });
		const handle = requireHandle(state, "opshot: test requires a state");

		expect(interiorReachesInternedOccupied(handle, state.box)).toBe(true);
		expect(interiorReachesInternedOccupied(handle, state.box.inner)).toBe(false);
	});

	it("terminates on a cyclic subtree", () => {
		const state = createMutableState({ box: { n: 1 } as { n: number; self?: object } });
		const handle = requireHandle(state, "opshot: test requires a state");

		state.box.self = state.box;

		expect(interiorReachesInternedOccupied(handle, state.box)).toBe(true);

		const detached: { self?: object } = {};

		detached.self = detached;

		expect(interiorReachesInternedOccupied(handle, detached)).toBe(false);
	});

	it("misses an interned-but-unoccupied node", () => {
		const state = createMutableState({ box: { n: 1 } as { n: number } | undefined });
		const handle = requireHandle(state, "opshot: test requires a state");
		const box = state.box!;

		expect(internedOccupied(handle, box)).toBe(true);

		delete state.box;

		expect(internedIdOf(handle, box)).toBeDefined();
		expect(edgeStatusOf(handle, box).occupied).toBe(false);
		expect(internedOccupied(handle, box)).toBe(false);
	});

	it("consults capture-staged ids without treating an unoccupied staged node as interned-occupied", () => {
		const state = createMutableState({ box: { n: 1 } });
		const handle = requireHandle(state, "opshot: test requires a state");
		const capture = createCaptureTables();
		const outsider = { n: 2 };
		const staged = stageVend(handle, capture, outsider);

		expect(internedOccupied(handle, state.box, capture)).toBe(true);
		expect(internedIdOf(handle, outsider, capture)).toBe(staged);
		expect(internedIdOf(handle, outsider)).toBeUndefined();
		expect(edgeStatusOf(handle, outsider).occupied).toBe(false);
		expect(internedOccupied(handle, outsider, capture)).toBe(false);
		expect(interiorReachesInternedOccupied(handle, { child: outsider }, capture)).toBe(false);
	});
});
