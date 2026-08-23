import { snapshot, unstable_getInternalStates } from "valtio/vanilla";
import { createMutableState } from "../createMutableState";
import {
	addInEdge,
	chainsAtRoot,
	childChainsOf,
	descendChains,
	edgeStatusOf,
	hasOtherRoutes,
	isChainsIgnored,
	isIgnoredFrontier,
	isTrackedEdge,
	nodeChainsOf,
	resolveChildChains,
	slotStatusOf,
} from "../edges";
import { requireHandle, type DirtyIndex } from "../handle";
import { ignore } from "../ignore";
import { bindVisitedOccupancy } from "../occupancy";
import { internedOccupied } from "./internedOccupancy";
import { transact } from "../transact/transact";
import { unsafeTrack } from "../unsafeTrack";
import { walkDataEntries } from "../utils/dataEntries";
import { admitDescendants, admitStep, emitsSkippedOccupancy, markChangedPath } from "./admission";
import { createOperationPath } from "./path";
import { isObjectLike } from "./predicates";

class PrivateStore {
	#hidden = 1;

	read(): number {
		return this.#hidden;
	}
}

class MethodHost {
	run = (): number => 1;
}

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

	it("isTrackedEdge is true only for a writable tracked child", () => {
		const frozen = Object.freeze({ n: 1 });
		const lockedChild = { n: 1 };
		const locked: { locked?: { n: number } } = {};

		Object.defineProperty(locked, "locked", { value: lockedChild, writable: false, enumerable: true });

		const host = new MethodHost();
		const bag = {
			plain: { n: 1 },
			frozen,
			scalar: 1,
			map: new Map<string, number>(),
			set: new Set<number>(),
			closed: new PrivateStore(),
		};
		const entries = Object.fromEntries(walkDataEntries(bag).map((entry) => [entry.key, entry]));
		const lockedEntry = walkDataEntries(locked)[0];
		const methodEntry = walkDataEntries(host).find((entry) => entry.key === "run");

		expect(isTrackedEdge(entries.plain!)).toBe(true);
		expect(isTrackedEdge(entries.frozen!)).toBe(false);
		expect(isTrackedEdge(entries.scalar!)).toBe(false);
		expect(isTrackedEdge(entries.map!)).toBe(false);
		expect(isTrackedEdge(entries.set!)).toBe(false);
		expect(isTrackedEdge(entries.closed!)).toBe(false);
		expect(methodEntry).toBeDefined();
		expect(isTrackedEdge(methodEntry!)).toBe(false);
		expect(lockedEntry).toBeDefined();
		expect(isTrackedEdge(lockedEntry!)).toBe(false);
	});

	it("seedFrom records no in-edge for a node reached only across a dangerous edge", () => {
		const map = new Map<string, number>([["k", 1]]);
		const state = createMutableState({ box: map }, { strict: false });
		const handle = requireHandle(state, "opshot: test requires a state");
		const raw = rawTargetOf(map);
		const record = handle.nodes.get(raw);

		expect(edgeStatusOf(handle, map).occupied).toBe(false);
		expect(internedOccupied(handle, map)).toBe(false);
		expect(record?.edges.length ?? 0).toBe(0);
	});

	it("resolveChildChains refuses an already-ignored parent residual", () => {
		const state = createMutableState({ wrap: ignore({ child: { n: 1 } }), tick: 0 });
		const handle = requireHandle(state, "opshot: test requires a state");
		const wrap = admitStep(
			handle,
			emptyDirty(),
			createOperationPath(["wrap"]),
			state,
			chainsAtRoot(handle.declarations),
		);

		expect(resolveChildChains(handle, wrap.liveChild, wrap.chains, "child", state.wrap.child)).toBeUndefined();
	});

	it("resolveChildChains refuses a declared-ignored key", () => {
		const state = createMutableState({ wrap: ignore({ n: 1 }), tick: 0 });
		const handle = requireHandle(state, "opshot: test requires a state");
		const residual = chainsAtRoot(handle.declarations);

		expect(resolveChildChains(handle, state, residual, "wrap", state.wrap)).toBeUndefined();
	});

	it("resolveChildChains refuses a sole-route child whose aliased parent declares the key ignored", () => {
		const state = createMutableState({
			a: { x: { n: 1 } },
			b: { x: ignore({ n: 1 }) },
		} as unknown as { a: { x: { n: number } }; b: { x: { n: number } } });

		transact(state, () => {
			state.b = state.a;
		});

		const handle = requireHandle(state, "opshot: test requires a state");
		const parent = state.a;
		const parentChains = nodeChainsOf(handle, parent);

		expect(parentChains).toBeDefined();
		expect(resolveChildChains(handle, parent, parentChains!, "x", state.a.x)).toBeUndefined();
	});

	it("resolveChildChains returns the descended set for a sole-route child", () => {
		const state = createMutableState({ box: { n: 1 } });
		const handle = requireHandle(state, "opshot: test requires a state");
		const residual = chainsAtRoot(handle.declarations);
		const resolved = resolveChildChains(handle, state, residual, "box", state.box);

		expect(resolved).toBeDefined();
		expect(resolved!.otherRoutes).toBe(false);
		expect(resolved!.chains).toEqual(descendChains(residual, "box").chains);
		expect(resolved!.descended).toEqual(descendChains(residual, "box").chains);
	});

	it("resolveChildChains returns nodeChainsOf for an other-routes child", () => {
		const state = createMutableState({
			a: { n: 1 },
			b: { n: 1 },
		} as unknown as { a: { n: number }; b: { n: number } });

		transact(state, () => {
			state.b = state.a;
		});

		const handle = requireHandle(state, "opshot: test requires a state");
		const residual = chainsAtRoot(handle.declarations);
		const resolved = resolveChildChains(handle, state, residual, "a", state.a);

		expect(hasOtherRoutes(handle, state.a, state, "a")).toBe(true);
		expect(resolved).toBeDefined();
		expect(resolved!.otherRoutes).toBe(true);
		expect(resolved!.chains).toEqual(nodeChainsOf(handle, state.a));
	});

	it("resolveChildChains falls back to the descended set for an ungrounded other-routes child", () => {
		const state = createMutableState({ box: { n: 1 } }) as { box?: { n: number } };
		const handle = requireHandle(state, "opshot: test requires a state");
		const child = state.box!;
		const extra = { held: child };

		addInEdge(handle, child, extra, "held");
		delete state.box;

		const residual = chainsAtRoot(handle.declarations);
		const descended = descendChains(residual, "box").chains;
		const resolved = resolveChildChains(handle, state, residual, "box", child);

		expect(nodeChainsOf(handle, child)).toBeUndefined();
		expect(hasOtherRoutes(handle, child, state, "box")).toBe(true);
		expect(resolved).toBeDefined();
		expect(resolved!.otherRoutes).toBe(true);
		expect(resolved!.chains).toEqual(descended);
	});

	it("resolveChildChains on a snapshot node matches the live counterpart", () => {
		const state = createMutableState({
			a: { n: 1 },
			b: { n: 1 },
		} as unknown as { a: { n: number }; b: { n: number } });

		transact(state, () => {
			state.b = state.a;
		});

		const handle = requireHandle(state, "opshot: test requires a state");
		const residual = chainsAtRoot(handle.declarations);
		const live = resolveChildChains(handle, state, residual, "a", state.a);
		const snap = snapshot(handle.proxy.root) as { a: { n: number }; b: { n: number } };
		const fromSnap = resolveChildChains(handle, snap, residual, "a", snap.a);

		expect(hasOtherRoutes(handle, state.a, state, "a")).toBe(true);
		expect(live).toBeDefined();
		expect(live!.otherRoutes).toBe(true);
		expect(live!.chains).toEqual(nodeChainsOf(handle, state.a));
		expect(fromSnap).toEqual(live);
	});
});
