import { unstable_getInternalStates } from "valtio/vanilla";
import { createMutableState } from "../createMutableState";
import { chainsAtRoot, childChainsOf } from "../edges";
import { requireHandle, type DirtyIndex } from "../handle";
import { ignore } from "../ignore";
import { unsafeTrack } from "../unsafeTrack";
import { admitDescendants, admitEmitPath, emitsSkippedOccupancy, isIgnoredPath, markChangedPath } from "./admission";
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
		const residual = childChainsOf(chainsAtRoot(handle.declarations), "box");

		expect(admitEmitPath(handle, dirty, path, residual)).toBe("continue");
		expect(isIgnoredPath(handle, path, residual)).toBe(false);
	});

	it("skips an ignored frontier", () => {
		const state = createMutableState({ wrap: ignore({ n: 1 }), tick: 0 });
		const handle = requireHandle(state, "opshot: test requires a state");
		const dirty = emptyDirty();
		const path = createOperationPath(["wrap"]);
		const residual = childChainsOf(chainsAtRoot(handle.declarations), "wrap");

		expect(admitEmitPath(handle, dirty, path, residual)).toBe("skip");
		expect(isIgnoredPath(handle, path, residual)).toBe(true);
	});

	it("skips an untracked lane", () => {
		const frozen = Object.freeze({ n: 1 });
		const state = createMutableState({ frozen, tick: 0 });
		const handle = requireHandle(state, "opshot: test requires a state");
		const dirty = emptyDirty();
		const path = createOperationPath(["frozen"]);
		const residual = childChainsOf(chainsAtRoot(handle.declarations), "frozen");

		expect(admitEmitPath(handle, dirty, path, residual)).toBe("skip");
		expect(isIgnoredPath(handle, path, residual)).toBe(false);
		expect(emitsSkippedOccupancy(frozen)).toBe(true);
		expect(emitsSkippedOccupancy(new Map())).toBe(false);
	});

	it("propagates unsafe through admitDescendants", () => {
		const map = new Map<string, number>([["k", 1]]);
		const state = createMutableState({ box: unsafeTrack({ held: map }) });
		const handle = requireHandle(state, "opshot: test requires a state");
		const visits = new Set<object>();
		const residual = childChainsOf(chainsAtRoot(handle.declarations), "box");

		admitDescendants(handle, createOperationPath(["box"]), visits, residual);

		expect(visits.has(rawTargetOf(state.box))).toBe(true);
		expect(visits.has(map)).toBe(true);
	});

	it("continues at the root path", () => {
		const state = createMutableState({ box: { n: 1 } });
		const handle = requireHandle(state, "opshot: test requires a state");
		const dirty = emptyDirty();
		const path = createOperationPath([]);
		const residual = chainsAtRoot(handle.declarations);

		expect(admitEmitPath(handle, dirty, path, residual)).toBe("continue");
		expect(isIgnoredPath(handle, path, residual)).toBe(false);
		expect(emitsSkippedOccupancy(state)).toBe(false);
	});

	it("marks the dirty index along a changed path", () => {
		const state = createMutableState({ box: { n: 1 } });
		const handle = requireHandle(state, "opshot: test requires a state");
		const dirty = emptyDirty();
		const path = createOperationPath(["box"]);

		markChangedPath(handle, dirty, path);

		expect(dirty.nodes.has(rawTargetOf(state))).toBe(true);
		expect(dirty.edges.get(rawTargetOf(state))?.has("box")).toBe(true);
	});
});
