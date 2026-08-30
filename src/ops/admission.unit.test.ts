import { unstable_getInternalStates } from "valtio/vanilla";
import { createMutableState } from "../createMutableState";
import { edgeStatusOf, hasOtherRoutes, isTrackedEdge } from "../edges";
import { requireHandle, type DirtyIndex } from "../handle";
import { ignore } from "../ignore";
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
		const verdict = admitStep(handle, dirty, path, state);

		expect(verdict.visit).toBe("continue");
		expect(verdict.ignored).toBe(false);
	});

	it("skips an ignored occupant", () => {
		const state = createMutableState({ wrap: ignore({ n: 1 }), tick: 0 });
		const handle = requireHandle(state, "opshot: test requires a state");
		const dirty = emptyDirty();
		const path = createOperationPath(["wrap"]);
		const verdict = admitStep(handle, dirty, path, state);

		expect(verdict.visit).toBe("skip");
		expect(verdict.ignored).toBe(true);
	});

	it("skips an untracked lane", () => {
		const frozen = Object.freeze({ n: 1 });
		const state = createMutableState({ frozen, tick: 0 });
		const handle = requireHandle(state, "opshot: test requires a state");
		const dirty = emptyDirty();
		const path = createOperationPath(["frozen"]);
		const verdict = admitStep(handle, dirty, path, state);

		expect(verdict.visit).toBe("skip");
		expect(verdict.ignored).toBe(false);
		expect(emitsSkippedOccupancy(frozen)).toBe(true);
		expect(emitsSkippedOccupancy(new Map())).toBe(false);
	});

	it("folds the retired admit and ignore pair into one verdict", () => {
		const tracked = createMutableState({ box: { n: 1 } });
		const trackedHandle = requireHandle(tracked, "opshot: test requires a state");
		const trackedVerdict = admitStep(trackedHandle, emptyDirty(), createOperationPath(["box"]), tracked);

		expect(trackedVerdict.ignored).toBe(false);
		expect(trackedVerdict.visit).toBe("continue");

		const wrapped = createMutableState({ wrap: ignore({ n: 1 }), tick: 0 });
		const wrappedHandle = requireHandle(wrapped, "opshot: test requires a state");
		const wrappedVerdict = admitStep(wrappedHandle, emptyDirty(), createOperationPath(["wrap"]), wrapped);

		expect(wrappedVerdict.ignored).toBe(true);
		expect(wrappedVerdict.visit).toBe("skip");

		const frozen = Object.freeze({ n: 1 });
		const skipped = createMutableState({ frozen, tick: 0 });
		const skippedHandle = requireHandle(skipped, "opshot: test requires a state");
		const skippedVerdict = admitStep(skippedHandle, emptyDirty(), createOperationPath(["frozen"]), skipped);

		expect(skippedVerdict.ignored).toBe(false);
		expect(skippedVerdict.visit).toBe("skip");
	});

	it("still ignores a marked occupant when dirty is undefined", () => {
		const state = createMutableState({ wrap: ignore({ n: 1 }), tick: 0 });
		const handle = requireHandle(state, "opshot: test requires a state");
		const path = createOperationPath(["wrap"]);
		const verdict = admitStep(handle, undefined, path, state);

		expect(verdict.ignored).toBe(true);
		expect(verdict.visit).toBe("continue");
	});

	it("propagates unsafe through admitDescendants", () => {
		const map = new Map<string, number>([["k", 1]]);
		const state = createMutableState({ box: unsafeTrack({ held: map }) });
		const handle = requireHandle(state, "opshot: test requires a state");
		const visits = new Set<object>();

		admitDescendants(handle, createOperationPath(["box"]), visits, state.box);

		expect(visits.has(rawTargetOf(state.box))).toBe(true);
		expect(visits.has(map)).toBe(true);
	});

	it("continues at the root path", () => {
		const state = createMutableState({ box: { n: 1 } });
		const handle = requireHandle(state, "opshot: test requires a state");
		const dirty = emptyDirty();
		const path = createOperationPath([]);
		const verdict = admitStep(handle, dirty, path, state);

		expect(verdict.visit).toBe("continue");
		expect(verdict.ignored).toBe(false);
		expect(verdict.liveChild).toBe(state);
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

	it("continues on a sole-route plain slot", () => {
		const state = createMutableState({ box: { n: 1 } });
		const handle = requireHandle(state, "opshot: test requires a state");
		const dirty = emptyDirty();
		const path = createOperationPath(["box"]);
		const verdict = admitStep(handle, dirty, path, state);
		const liveChild = state.box;

		expect(isObjectLike(liveChild)).toBe(true);
		expect(hasOtherRoutes(handle, liveChild, state, "box")).toBe(false);
		expect(verdict.visit).toBe("continue");
		expect(verdict.ignored).toBe(false);
	});

	it("reports a deleted node as unoccupied", () => {
		const state = createMutableState({
			box: { n: 1 },
			tainted: unsafeTrack({ n: 1 }),
		} as unknown as { box?: { n: number }; tainted: { n: number } });
		const handle = requireHandle(state, "opshot: test requires a state");
		const box = state.box!;

		delete state.box;

		expect(edgeStatusOf(handle, box).occupied).toBe(false);
	});

	it("continues on an aliased node whose second route entered unsafe-marked", () => {
		const state = createMutableState({
			a: { x: { n: 1 } },
			b: unsafeTrack({ x: { n: 1 } }),
		} as unknown as { a: { x: { n: number } }; b: { x: { n: number } } });

		transact(state, () => {
			state.a = state.b;
		});

		const handle = requireHandle(state, "opshot: test requires a state");
		const dirty = emptyDirty();
		const path = createOperationPath(["a"]);
		const verdict = admitStep(handle, dirty, path, state);
		const liveChild = state.a;

		expect(hasOtherRoutes(handle, liveChild, state, "a")).toBe(true);
		expect(verdict.ignored).toBe(false);
		expect(verdict.visit).toBe("continue");
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
		const parentVerdict = admitStep(handle, dirty, createOperationPath(["a"]), state);
		const path = createOperationPath(["a", "y"]);
		const verdict = admitStep(handle, dirty, path, parentVerdict.liveChild);
		const liveParent = state.a;

		expect(hasOtherRoutes(handle, liveParent, state, "a")).toBe(true);
		expect(isObjectLike(verdict.liveChild)).toBe(true);
		expect(verdict.visit).toBe("skip");
		expect(verdict.ignored).toBe(true);
	});

	it("terminates a self-loop", () => {
		const state = createMutableState({
			box: { n: 1 } as { n: number; self?: { n: number } },
		});

		transact(state, () => {
			state.box.self = state.box;
		});

		const handle = requireHandle(state, "opshot: test requires a state");
		const dirty = emptyDirty();
		const boxVerdict = admitStep(handle, dirty, createOperationPath(["box"]), state);
		const path = createOperationPath(["box", "self"]);
		const verdict = admitStep(handle, dirty, path, boxVerdict.liveChild);
		const liveParent = state.box;
		const liveChild = state.box.self;

		expect(liveChild).toBe(state.box);
		expect(isObjectLike(liveChild)).toBe(true);

		if (isObjectLike(liveChild)) {
			expect(hasOtherRoutes(handle, liveChild, liveParent, "self")).toBe(true);
		}

		expect(verdict.ignored).toBe(false);
		expect(verdict.visit).toBe("continue");

		const visits = new Set<object>();

		admitDescendants(handle, createOperationPath(["box"]), visits, state.box);

		expect(visits.has(rawTargetOf(state.box))).toBe(true);
		expect(visits.size).toBe(1);
	});

	it("admits a sole-route child under an aliased parent when only one factory occupancy was ignored", () => {
		const state = createMutableState({
			a: { x: { n: 1 } },
			b: { x: ignore({ n: 1 }) },
		} as unknown as { a: { x: { n: number } }; b: { x: { n: number } } });

		transact(state, () => {
			state.b = state.a;
		});

		const handle = requireHandle(state, "opshot: test requires a state");
		const dirty = emptyDirty();
		const viaA = admitStep(handle, dirty, createOperationPath(["a"]), state);
		const viaB = admitStep(handle, dirty, createOperationPath(["b"]), state);
		const parent = state.a;

		expect(viaA.liveChild).toBe(parent);
		expect(viaB.liveChild).toBe(parent);
		expect(hasOtherRoutes(handle, parent, state, "a")).toBe(true);
		expect(hasOtherRoutes(handle, parent, state, "b")).toBe(true);

		const atAX = admitStep(handle, dirty, createOperationPath(["a", "x"]), viaA.liveChild);
		const atBX = admitStep(handle, dirty, createOperationPath(["b", "x"]), viaB.liveChild);
		const liveX = state.a.x;

		expect(hasOtherRoutes(handle, liveX, parent, "x")).toBe(false);
		expect(atAX.visit).toBe("continue");
		expect(atAX.ignored).toBe(false);
		expect(atBX.visit).toBe("continue");
		expect(atBX.ignored).toBe(false);
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

	it("isTrackedEdge is false for an ignore-marked child", () => {
		const hidden = { n: 1 };

		ignore(hidden);

		const entries = Object.fromEntries(walkDataEntries({ hidden }).map((entry) => [entry.key, entry]));

		expect(isTrackedEdge(entries.hidden!)).toBe(false);
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
});
