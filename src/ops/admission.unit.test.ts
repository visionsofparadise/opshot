import { unstable_getInternalStates } from "valtio/vanilla";
import { createMutableState } from "../createMutableState";
import { chainsAtRoot, childChainsOf } from "../edges";
import { requireHandle, type DirtyIndex } from "../handle";
import { ignore } from "../ignore";
import { unsafeTrack } from "../unsafeTrack";
import { admitDescendants, admitStep, emitsSkippedOccupancy, markChangedPath } from "./admission";
import { createOperationPath } from "./path";

const { proxyStateMap } = unstable_getInternalStates();

const rawTargetOf = (value: object): object => proxyStateMap.get(value)?.[0] ?? value;

const emptyDirty = (): DirtyIndex => ({ edges: new WeakMap(), nodes: new WeakSet() });

describe("admission", () => {
	it("continues on a plain tracked slot", () => {
		const state = createMutableState({ box: { n: 1 } });
		const handle = requireHandle(state, "opshot: test requires a state");
		const dirty = emptyDirty();
		const path = createOperationPath(["box"]);
		const residual = chainsAtRoot(handle.declarations);
		const verdict = admitStep(handle, dirty, path, state, residual);

		expect(verdict.visit).toBe("continue");
		expect(verdict.ignored).toBe(false);
	});

	it("skips an ignored frontier", () => {
		const state = createMutableState({ wrap: ignore({ n: 1 }), tick: 0 });
		const handle = requireHandle(state, "opshot: test requires a state");
		const dirty = emptyDirty();
		const path = createOperationPath(["wrap"]);
		const residual = chainsAtRoot(handle.declarations);
		const verdict = admitStep(handle, dirty, path, state, residual);

		expect(verdict.visit).toBe("skip");
		expect(verdict.ignored).toBe(true);
	});

	it("skips an untracked lane", () => {
		const frozen = Object.freeze({ n: 1 });
		const state = createMutableState({ frozen, tick: 0 });
		const handle = requireHandle(state, "opshot: test requires a state");
		const dirty = emptyDirty();
		const path = createOperationPath(["frozen"]);
		const residual = chainsAtRoot(handle.declarations);
		const verdict = admitStep(handle, dirty, path, state, residual);

		expect(verdict.visit).toBe("skip");
		expect(verdict.ignored).toBe(false);
		expect(emitsSkippedOccupancy(frozen)).toBe(true);
		expect(emitsSkippedOccupancy(new Map())).toBe(false);
	});

	it("folds the retired admit and ignore pair into one verdict", () => {
		const tracked = createMutableState({ box: { n: 1 } });
		const trackedHandle = requireHandle(tracked, "opshot: test requires a state");
		const trackedVerdict = admitStep(
			trackedHandle,
			emptyDirty(),
			createOperationPath(["box"]),
			tracked,
			chainsAtRoot(trackedHandle.declarations),
		);

		expect(trackedVerdict.ignored).toBe(false);
		expect(trackedVerdict.visit).toBe("continue");

		const wrapped = createMutableState({ wrap: ignore({ n: 1 }), tick: 0 });
		const wrappedHandle = requireHandle(wrapped, "opshot: test requires a state");
		const wrappedVerdict = admitStep(
			wrappedHandle,
			emptyDirty(),
			createOperationPath(["wrap"]),
			wrapped,
			chainsAtRoot(wrappedHandle.declarations),
		);

		expect(wrappedVerdict.ignored).toBe(true);
		expect(wrappedVerdict.visit).toBe("skip");

		const frozen = Object.freeze({ n: 1 });
		const skipped = createMutableState({ frozen, tick: 0 });
		const skippedHandle = requireHandle(skipped, "opshot: test requires a state");
		const skippedVerdict = admitStep(
			skippedHandle,
			emptyDirty(),
			createOperationPath(["frozen"]),
			skipped,
			chainsAtRoot(skippedHandle.declarations),
		);

		expect(skippedVerdict.ignored).toBe(false);
		expect(skippedVerdict.visit).toBe("skip");
	});

	it("still ignores a path when dirty is undefined", () => {
		const state = createMutableState({ wrap: ignore({ n: 1 }), tick: 0 });
		const handle = requireHandle(state, "opshot: test requires a state");
		const path = createOperationPath(["wrap"]);
		const residual = chainsAtRoot(handle.declarations);
		const verdict = admitStep(handle, undefined, path, state, residual);

		expect(verdict.ignored).toBe(true);
		expect(verdict.visit).toBe("continue");
	});

	it("propagates unsafe through admitDescendants", () => {
		const map = new Map<string, number>([["k", 1]]);
		const state = createMutableState({ box: unsafeTrack({ held: map }) });
		const handle = requireHandle(state, "opshot: test requires a state");
		const visits = new Set<object>();
		const residual = childChainsOf(chainsAtRoot(handle.declarations), "box");

		admitDescendants(handle, createOperationPath(["box"]), visits, residual, state.box);

		expect(visits.has(rawTargetOf(state.box))).toBe(true);
		expect(visits.has(map)).toBe(true);
	});

	it("continues at the root path", () => {
		const state = createMutableState({ box: { n: 1 } });
		const handle = requireHandle(state, "opshot: test requires a state");
		const dirty = emptyDirty();
		const path = createOperationPath([]);
		const residual = chainsAtRoot(handle.declarations);
		const verdict = admitStep(handle, dirty, path, state, residual);

		expect(verdict.visit).toBe("continue");
		expect(verdict.ignored).toBe(false);
		expect(verdict.liveChild).toBe(state);
		expect(verdict.chains).toBe(residual);
		expect(emitsSkippedOccupancy(state)).toBe(false);
	});

	it("marks the dirty index along a changed path", () => {
		const state = createMutableState({ box: { n: 1 } });
		const handle = requireHandle(state, "opshot: test requires a state");
		const dirty = emptyDirty();
		const path = createOperationPath(["box"]);

		markChangedPath(handle, dirty, path, state);

		expect(dirty.nodes.has(rawTargetOf(state))).toBe(true);
		expect(dirty.edges.get(rawTargetOf(state))?.has("box")).toBe(true);
	});
});
