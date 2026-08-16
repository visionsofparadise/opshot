import { unstable_getInternalStates } from "valtio/vanilla";
import { createMutableState } from "../createMutableState";
import { handleOf, handlesOf } from "../handle";
import { ignore } from "../ignore";
import { subscribe } from "../subscribe";
import { transact } from "../transact/transact";
import { externalRoutesOf, routeUnderPath } from "./commitWalk";
import { createOperationPath } from "./path";

const { proxyStateMap } = unstable_getInternalStates();

const rawTargetOf = (value: object): object => proxyStateMap.get(value)?.[0] ?? value;

const requireHandle = (state: object) => {
	const handle = handleOf(state);

	if (handle === undefined) throw new Error("expected a handle");

	return handle;
};

const routeSegmentsOf = (handle: ReturnType<typeof requireHandle>, node: object): Array<Array<string | number>> =>
	[...(handle.routes.get(rawTargetOf(node)) ?? [])].map((path) => [...path]);

describe("handle routes", () => {
	it("returns the first-encounter route as canonical and every found route", () => {
		const shared = { n: 1 };
		const state = createMutableState({
			a: { b: shared },
			b: shared,
			c: shared,
		});
		const handle = requireHandle(state);
		const live = rawTargetOf(state.a.b as object);

		expect(routeSegmentsOf(handle, state.a.b as object)).toEqual([["a", "b"], ["b"], ["c"]]);
		expect(handle.members.has(live)).toBe(true);
		expect((handle.routes.get(live) ?? []).length > 1).toBe(true);
	});

	it("reports unreachable for a detached node", () => {
		const state = createMutableState({ a: { n: 1 } });
		const detached = { n: 2 };
		const handle = requireHandle(state);

		expect(handle.routes.get(detached)).toBeUndefined();
		expect(handle.members.has(detached)).toBe(false);
	});

	it("reports unreachable for a cross-graph node", () => {
		const shared = { n: 1 };
		const stateA = createMutableState({ held: shared });
		const stateB = createMutableState({ other: { n: 2 } });
		const handleB = requireHandle(stateB);

		expect(handleB.routes.get(rawTargetOf(stateA.held as object))).toBeUndefined();
		expect(handlesOf(stateA.held as object)).toContain(requireHandle(stateA));
		expect(handlesOf(stateA.held as object)).not.toContain(handleB);
	});

	it("publishes the empty path as the tracked factory return's route", () => {
		const state = createMutableState({ a: { n: 1 } });
		const handle = requireHandle(state);

		expect(handle.routes.get(rawTargetOf(state))).toEqual([createOperationPath([])]);
		expect(handle.members.has(rawTargetOf(state))).toBe(true);
	});

	it("does not create a handle for a frozen factory argument", () => {
		const frozen = Object.freeze({ a: { n: 1 } });
		const returned = createMutableState(frozen);

		expect(returned).toBe(frozen);
		expect(handleOf(frozen)).toBeUndefined();
	});

	it("does not record routes through an ignored factory occupancy", () => {
		const hidden = { n: 1 };
		const state = createMutableState({
			open: { n: 2 },
			wrapped: ignore({ held: hidden }),
		});
		const handle = requireHandle(state);

		expect(routeSegmentsOf(handle, state.open)).toEqual([["open"]]);
		expect(handle.routes.get(rawTargetOf(hidden))).toBeUndefined();
	});

	it("records the empty path and the self segment after a self assignment", () => {
		const state = createMutableState<{ self?: object }>({});

		transact(state, () => {
			state.self = state;
		});

		expect(requireHandle(state).routes.get(rawTargetOf(state))).toEqual([
			createOperationPath([]),
			createOperationPath(["self"]),
		]);
	});

	it("records the empty path and the back-edge after a child back-edge", () => {
		const state = createMutableState<{ child: { back?: object } }>({ child: {} });

		transact(state, () => {
			state.child.back = state;
		});

		expect(requireHandle(state).routes.get(rawTargetOf(state))).toEqual([
			createOperationPath([]),
			createOperationPath(["child", "back"]),
		]);
	});

	it("is cycle-safe and records every simple route to the cycle node", () => {
		const state = createMutableState<{ box: { n: number; self?: object } }>({ box: { n: 1 } });

		transact(state, () => {
			state.box.self = state.box;
		});

		expect(routeSegmentsOf(requireHandle(state), state.box as object)).toEqual([["box"], ["box", "self"]]);
	});

	it("does not descend into ignored children", () => {
		const hidden = { n: 1 };
		const state = createMutableState({
			open: { n: 2 },
			wrapped: ignore({ held: hidden }),
		});
		const handle = requireHandle(state);

		expect(routeSegmentsOf(handle, state.open)).toEqual([["open"]]);
		expect(handle.routes.get(hidden)).toBeUndefined();
	});

	it("does not descend a frozen child", () => {
		const nested = { n: 2 };
		const frozen = Object.freeze({ n: 1, nested });
		const state = createMutableState({ child: frozen });
		const handle = requireHandle(state);

		expect(handle.routes.get(rawTargetOf(frozen))).toBeUndefined();
		expect(handle.routes.get(rawTargetOf(nested))).toBeUndefined();
	});

	it("mints numeric segments for array indexes", () => {
		const item = { n: 1 };
		const state = createMutableState({ list: [item] });
		const routes = requireHandle(state).routes.get(rawTargetOf(state.list[0] as object)) ?? [];

		expect(routes).toHaveLength(1);
		expect([...routes[0]!]).toEqual(["list", 0]);
		expect(typeof routes[0]![1]).toBe("number");
	});

	it("compares segments strictly in routeUnderPath", () => {
		const numeric = createOperationPath(["list", 0]);
		const stringy = createOperationPath(["list", "0"]);

		expect(routeUnderPath(numeric, createOperationPath(["list", 0]))).toBe(true);
		expect(routeUnderPath(numeric, createOperationPath(["list", "0"]))).toBe(false);
		expect(routeUnderPath(stringy, createOperationPath(["list", 0]))).toBe(false);
	});

	it("externalRoutesOf drops routes under the formation path", () => {
		const routes = [createOperationPath(["a", "b"]), createOperationPath(["b2"]), createOperationPath(["b2", "x"])];

		expect(externalRoutesOf(routes, createOperationPath(["b2"])).map((path) => [...path])).toEqual([["a", "b"]]);
	});
});

describe("handle routes (sharing)", () => {
	it("adds a second route when an already-tracked node is assigned", () => {
		const state = createMutableState<{ held: { n: number }; alias?: { n: number } }>({ held: { n: 1 } });
		const handle = requireHandle(state);

		expect(routeSegmentsOf(handle, state.held)).toEqual([["held"]]);
		expect(handlesOf(state.held)).toContain(handle);

		transact(state, () => {
			state.alias = state.held;
		});

		expect(routeSegmentsOf(handle, state.held)).toEqual([["held"], ["alias"]]);
		expect(handlesOf(state.held)).toContain(handle);
	});

	it("records an embedded tracked node through a fresh carrier", () => {
		const state = createMutableState<{ held: { n: number }; wrap?: { inner: { n: number } } }>({
			held: { n: 1 },
		});
		const handle = requireHandle(state);

		transact(state, () => {
			state.wrap = { inner: state.held };
		});

		expect(routeSegmentsOf(handle, state.held)).toEqual([["held"], ["wrap", "inner"]]);
		expect(handlesOf(state.held)).toContain(handle);
	});

	it("records both init-time aliases on the seed walk", () => {
		const shared = { n: 1 };
		const state = createMutableState({ a: shared, alias: shared });
		const handle = requireHandle(state);

		expect(routeSegmentsOf(handle, state.a)).toEqual([["a"], ["alias"]]);
		expect(rawTargetOf(state.a)).toBe(rawTargetOf(state.alias));
		expect(handlesOf(state.a)).toContain(handle);
	});

	it("leaves routes unchanged when a write is refused", () => {
		const source: { hub: { n: number }; slot?: unknown } = { hub: { n: 1 } };

		Object.defineProperty(source, "slot", { value: undefined, writable: false, enumerable: true });

		const state = createMutableState(source);
		const handle = requireHandle(state);

		expect(() => {
			state.slot = state.hub;
		}).toThrow("trap returned falsish");

		expect(routeSegmentsOf(handle, state.hub)).toEqual([["hub"]]);
		expect(handle.routes.get(rawTargetOf(state.hub))?.some((path) => path[0] === "slot")).toBeFalsy();
	});

	it("indexes a shared live on each admitting handle", () => {
		const strict = createMutableState({ node: { n: 1 } });
		const loose = createMutableState<{ hub: { n: number }; slot?: unknown }>({ hub: { n: 1 } }, { strict: false });

		transact(loose, () => {
			loose.slot = strict.node;
		});

		expect(loose.slot).toBe(strict.node);
		expect(routeSegmentsOf(requireHandle(strict), strict.node)).toEqual([["node"]]);
		expect(routeSegmentsOf(requireHandle(loose), strict.node)).toEqual([["slot"]]);
		expect(handlesOf(strict.node)).toEqual(expect.arrayContaining([requireHandle(strict), requireHandle(loose)]));
	});
});

describe("formation detection (handle tables)", () => {
	it("detects init-time aliasing on the seed walk", () => {
		const shared = { n: 1 };
		const state = createMutableState({ a: shared, alias: shared });
		const handle = requireHandle(state);

		expect(routeSegmentsOf(handle, state.a)).toEqual([["a"], ["alias"]]);
		expect((handle.routes.get(rawTargetOf(state.a)) ?? []).length).toBe(2);
	});

	it("detects cross-tick aliasing on the emit descent", async () => {
		const state = createMutableState<{ a: { n: number }; alias?: { n: number } }>({ a: { n: 1 } });

		await Promise.resolve();
		await Promise.resolve();

		transact(state, () => {
			state.alias = state.a;
		});

		const handle = requireHandle(state);

		expect(routeSegmentsOf(handle, state.a)).toEqual([["a"], ["alias"]]);
		expect(handlesOf(state.a)).toContain(handle);
	});

	it("isolates multi-state sharing as per-handle tables", async () => {
		const deferred: Array<() => void> = [];
		const emitOn = (flush: () => void): void => {
			deferred.push(flush);
		};
		const shared = { n: 1 };
		const stateA = createMutableState<{ held: { n: number }; alias?: { n: number } }>({ held: shared }, { emitOn });
		const stateB = createMutableState<{ held: { n: number }; alias?: { n: number } }>({ held: shared });
		const heardA = new Array<unknown>();
		const heardB = new Array<unknown>();

		subscribe(stateA, (ops) => {
			heardA.push(ops);
		});
		subscribe(stateB, (ops) => {
			heardB.push(ops);
		});

		stateA.alias = stateA.held;
		stateB.alias = stateB.held;

		await Promise.resolve();
		await Promise.resolve();

		expect(heardB).toHaveLength(1);
		expect(heardA).toHaveLength(0);

		const handleA = requireHandle(stateA);
		const handleB = requireHandle(stateB);

		expect(routeSegmentsOf(handleA, stateA.held)).toEqual([["held"]]);
		expect(routeSegmentsOf(handleB, stateB.held)).toEqual([["held"], ["alias"]]);
		expect(handleA.routes.get(rawTargetOf(stateB))).toBeUndefined();
		expect(handleB.routes.get(rawTargetOf(stateA))).toBeUndefined();

		for (const flush of deferred) flush();

		expect(heardA).toHaveLength(1);
		expect(routeSegmentsOf(handleA, stateA.held)).toEqual([["held"], ["alias"]]);
		expect(heardB).toHaveLength(1);
	});

	it("detects nested cycle formation on the emit descent", () => {
		const state = createMutableState<{ box: { n: number; self?: object } }>({ box: { n: 1 } });

		transact(state, () => {
			state.box.self = state.box;
		});

		const handle = requireHandle(state);

		expect(routeSegmentsOf(handle, state.box as object)).toEqual([["box"], ["box", "self"]]);
		expect(handlesOf(state.box as object)).toContain(handle);
	});
});
