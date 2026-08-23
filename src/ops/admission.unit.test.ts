import { unstable_getInternalStates } from "valtio/vanilla";
import { createMutableState } from "../createMutableState";
import {
	chainsAtRoot,
	childChainsOf,
	descendChains,
	edgeStatusOf,
	hasOtherRoutes,
	isChainsIgnored,
	isIgnoredFrontier,
	nodeChainsOf,
	slotStatusOf,
} from "../edges";
import { requireHandle, type DirtyIndex } from "../handle";
import { ignore } from "../ignore";
import { bindVisitedOccupancy } from "../occupancy";
import { transact } from "../transact/transact";
import { unsafeTrack } from "../unsafeTrack";
import { admitDescendants, admitStep, emitsSkippedOccupancy, markChangedPath } from "./admission";
import { createOperationPath } from "./path";
import { isObjectLike } from "./predicates";

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

	it("agrees with the climb on a sole-route plain slot", () => {
		const state = createMutableState({ box: { n: 1 } });
		const handle = requireHandle(state, "opshot: test requires a state");
		const dirty = emptyDirty();
		const path = createOperationPath(["box"]);
		const residual = chainsAtRoot(handle.declarations);
		const verdict = admitStep(handle, dirty, path, state, residual);
		const liveChild = state.box;

		expect(isObjectLike(liveChild)).toBe(true);
		expect(hasOtherRoutes(handle, liveChild, state, "box")).toBe(false);
		expect(verdict.visit).toBe("continue");
		expect(verdict.ignored).toBe(false);
		expect(verdict.chains).toEqual(descendChains(residual, "box").chains);
		expect(verdict.chains).toEqual(nodeChainsOf(handle, liveChild));
		expect(verdict.ignored).toBe(
			isIgnoredFrontier(handle, state, "box") || isChainsIgnored(childChainsOf(residual, "box")),
		);
		expect(verdict.visit).toBe(
			bindVisitedOccupancy(handle, path, state, "box", liveChild, slotStatusOf(handle, state, "box").unsafe),
		);
	});

	it("distinguishes a node with no grounded occupancy from one whose chains are all tainted", () => {
		const state = createMutableState({
			box: { n: 1 },
			tainted: unsafeTrack({ n: 1 }),
		} as unknown as { box?: { n: number }; tainted: { n: number } });
		const handle = requireHandle(state, "opshot: test requires a state");
		const box = state.box!;

		expect(nodeChainsOf(handle, state.tainted)).toEqual([]);

		delete state.box;

		expect(edgeStatusOf(handle, box).occupied).toBe(false);
		expect(nodeChainsOf(handle, box)).toBeUndefined();
	});

	it("matches climb unsafe and visit on an aliased node with a tainted second route", () => {
		const state = createMutableState({
			a: { x: { n: 1 } },
			b: unsafeTrack({ x: { n: 1 } }),
		} as unknown as { a: { x: { n: number } }; b: { x: { n: number } } });

		transact(state, () => {
			state.a = state.b;
		});

		const handle = requireHandle(state, "opshot: test requires a state");
		const dirty = emptyDirty();
		const residual = chainsAtRoot(handle.declarations);
		const path = createOperationPath(["a"]);
		const verdict = admitStep(handle, dirty, path, state, residual);
		const liveChild = state.a;

		expect(hasOtherRoutes(handle, liveChild, state, "a")).toBe(true);
		expect(verdict.chains).toEqual(nodeChainsOf(handle, liveChild));

		const slot = slotStatusOf(handle, state, "a");
		const status = edgeStatusOf(handle, liveChild);
		const climbUnsafe = status.occupied ? status.unsafe : slot.unsafe;
		const climbIgnored = isChainsIgnored(childChainsOf(residual, "a")) || isIgnoredFrontier(handle, state, "a");

		expect(verdict.ignored).toBe(climbIgnored);
		expect(verdict.visit).toBe(bindVisitedOccupancy(handle, path, state, "a", liveChild, climbUnsafe));
	});

	it("skips an aliased node whose second route is ignored", () => {
		const state = createMutableState({
			a: { y: { n: 1 } },
			b: { y: ignore({ n: 1 }) },
		} as unknown as { a: { y: { n: number } }; b: { y: { n: number } } });

		transact(state, () => {
			state.a = state.b;
		});

		const handle = requireHandle(state, "opshot: test requires a state");
		const dirty = emptyDirty();
		const residual = chainsAtRoot(handle.declarations);
		const parentVerdict = admitStep(handle, dirty, createOperationPath(["a"]), state, residual);
		const path = createOperationPath(["a", "y"]);
		const verdict = admitStep(handle, dirty, path, parentVerdict.liveChild, parentVerdict.chains);
		const liveParent = state.a;

		expect(hasOtherRoutes(handle, liveParent, state, "a")).toBe(true);
		expect(isObjectLike(verdict.liveChild)).toBe(true);

		if (isObjectLike(verdict.liveChild)) {
			expect(hasOtherRoutes(handle, verdict.liveChild, liveParent, "y")).toBe(false);
		}

		expect(verdict.visit).toBe("skip");
		expect(verdict.ignored).toBe(true);
		expect(isIgnoredFrontier(handle, liveParent, "y")).toBe(true);
		expect(slotStatusOf(handle, liveParent, "y").ignored).toBe(true);
	});

	it("terminates a self-loop and agrees with the climb", () => {
		const state = createMutableState({
			box: { n: 1 } as { n: number; self?: { n: number } },
		});

		transact(state, () => {
			state.box.self = state.box;
		});

		const handle = requireHandle(state, "opshot: test requires a state");
		const dirty = emptyDirty();
		const residual = chainsAtRoot(handle.declarations);
		const boxVerdict = admitStep(handle, dirty, createOperationPath(["box"]), state, residual);
		const path = createOperationPath(["box", "self"]);
		const verdict = admitStep(handle, dirty, path, boxVerdict.liveChild, boxVerdict.chains);
		const liveParent = state.box;
		const liveChild = state.box.self;

		expect(liveChild).toBe(state.box);
		expect(isObjectLike(liveChild)).toBe(true);

		if (isObjectLike(liveChild)) {
			expect(hasOtherRoutes(handle, liveChild, liveParent, "self")).toBe(true);
			expect(verdict.chains).toEqual(nodeChainsOf(handle, liveChild));
		}

		const slot = slotStatusOf(handle, liveParent, "self");
		const status = isObjectLike(liveChild) ? edgeStatusOf(handle, liveChild) : { occupied: false, unsafe: false };
		const climbUnsafe = status.occupied ? status.unsafe : slot.unsafe;
		const climbIgnored =
			isChainsIgnored(childChainsOf(boxVerdict.chains, "self")) || isIgnoredFrontier(handle, liveParent, "self");

		expect(verdict.ignored).toBe(climbIgnored);
		expect(verdict.visit).toBe(bindVisitedOccupancy(handle, path, liveParent, "self", liveChild, climbUnsafe));

		const visits = new Set<object>();

		admitDescendants(handle, createOperationPath(["box"]), visits, boxVerdict.chains, state.box);

		expect(visits.has(rawTargetOf(state.box))).toBe(true);
		expect(visits.size).toBe(1);
	});

	it("skips both occurrences of a sole-route child under an aliased parent with ignore on one route", () => {
		const state = createMutableState({
			a: { x: { n: 1 } },
			b: { x: ignore({ n: 1 }) },
		} as unknown as { a: { x: { n: number } }; b: { x: { n: number } } });

		transact(state, () => {
			state.b = state.a;
		});

		const handle = requireHandle(state, "opshot: test requires a state");
		const dirty = emptyDirty();
		const residual = chainsAtRoot(handle.declarations);
		const viaA = admitStep(handle, dirty, createOperationPath(["a"]), state, residual);
		const viaB = admitStep(handle, dirty, createOperationPath(["b"]), state, residual);
		const parent = state.a;

		expect(viaA.liveChild).toBe(parent);
		expect(viaB.liveChild).toBe(parent);
		expect(hasOtherRoutes(handle, parent, state, "a")).toBe(true);
		expect(hasOtherRoutes(handle, parent, state, "b")).toBe(true);
		expect(viaA.chains).toEqual(nodeChainsOf(handle, parent));
		expect(viaB.chains).toEqual(nodeChainsOf(handle, parent));
		expect(viaA.chains).not.toEqual(slotStatusOf(handle, state, "a").chains);

		const atAX = admitStep(handle, dirty, createOperationPath(["a", "x"]), viaA.liveChild, viaA.chains);
		const atBX = admitStep(handle, dirty, createOperationPath(["b", "x"]), viaB.liveChild, viaB.chains);
		const liveX = state.a.x;

		expect(hasOtherRoutes(handle, liveX, parent, "x")).toBe(false);
		expect(atAX.visit).toBe("skip");
		expect(atAX.ignored).toBe(true);
		expect(atBX.visit).toBe("skip");
		expect(atBX.ignored).toBe(true);
		expect(isIgnoredFrontier(handle, parent, "x")).toBe(true);
	});
});
