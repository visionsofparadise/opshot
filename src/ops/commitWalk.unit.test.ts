import { unstable_getInternalStates } from "valtio/vanilla";
import { createMutableState } from "../createMutableState";
import { ignore } from "../ignore";
import { subscribe } from "../subscribe";
import { createRouteIndex, externalRoutesOf, flagPossiblyShared, isPossiblyShared, routeUnderPath } from "./commitWalk";
import { createOperationPath } from "./path";

const { proxyStateMap } = unstable_getInternalStates();

const rawTargetOf = (value: object): object => proxyStateMap.get(value)?.[0] ?? value;

describe("createRouteIndex", () => {
	it("returns the first-encounter route as canonical and every found route", () => {
		const shared = { n: 1 };
		const state = createMutableState({
			a: { b: shared },
			b: shared,
			c: shared,
		});

		const index = createRouteIndex(state);
		const routes = index.routesOf(state.a.b as object);

		expect(routes.map((path) => [...path])).toEqual([["a", "b"], ["b"], ["c"]]);
		expect(index.sharedLives.has(rawTargetOf(state.a.b as object))).toBe(true);
	});

	it("reports unreachable for a detached node", () => {
		const state = createMutableState({ a: { n: 1 } });
		const detached = { n: 2 };
		const index = createRouteIndex(state);

		expect(index.routesOf(detached)).toEqual([]);
	});

	it("reports unreachable for a cross-graph node", () => {
		const shared = { n: 1 };
		const stateA = createMutableState({ held: shared });
		const stateB = createMutableState({ other: { n: 2 } });
		const index = createRouteIndex(stateB);

		expect(index.routesOf(stateA.held as object)).toEqual([]);
	});

	it("gives the root no addressable route, the empty path not being one", () => {
		const state = createMutableState({ a: { n: 1 } });
		const index = createRouteIndex(state);

		expect(index.routesOf(state)).toEqual([]);
	});

	it("is cycle-safe and records every simple route to the cycle node", () => {
		const state = createMutableState<{ box: { n: number; self?: object } }>({ box: { n: 1 } });

		state.box.self = state.box;

		const index = createRouteIndex(state);
		const routes = index.routesOf(state.box as object);

		expect(routes.map((path) => [...path])).toEqual([["box"], ["box", "self"]]);
	});

	it("does not descend into refSet children", () => {
		const hidden = { n: 1 };
		const state = createMutableState({
			open: { n: 2 },
			wrapped: ignore({ held: hidden }),
		});

		const index = createRouteIndex(state);

		expect(index.routesOf(state.open).map((path) => [...path])).toEqual([["open"]]);
		expect(index.routesOf(hidden)).toEqual([]);
	});

	it("mints numeric segments for array indexes", () => {
		const item = { n: 1 };
		const state = createMutableState({ list: [item] });
		const index = createRouteIndex(state);
		const routes = index.routesOf(state.list[0] as object);

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

describe("sharing hint", () => {
	it("flags on direct assignment of an already-tracked proxy", () => {
		const state = createMutableState<{ held: { n: number }; alias?: { n: number } }>({ held: { n: 1 } });

		expect(isPossiblyShared(state.held)).toBe(false);

		state.alias = state.held;

		expect(isPossiblyShared(state.held)).toBe(true);
	});

	it("flags an embedded tracked node through initializer replay", () => {
		const state = createMutableState<{ held: { n: number }; wrap?: { inner: { n: number } } }>({
			held: { n: 1 },
		});

		state.wrap = { inner: state.held };

		expect(isPossiblyShared(state.held)).toBe(true);
	});

	it("flags a duplicate raw reference through the proxyCache arm", () => {
		const shared = { n: 1 };
		const state = createMutableState({ a: shared, alias: shared });

		expect(isPossiblyShared(state.a)).toBe(true);
		expect(isPossiblyShared(state.alias)).toBe(true);
		expect(rawTargetOf(state.a)).toBe(rawTargetOf(state.alias));
	});

	it("records an explicit flagPossiblyShared call", () => {
		const node = { n: 1 };

		expect(isPossiblyShared(node)).toBe(false);

		flagPossiblyShared(node);

		expect(isPossiblyShared(node)).toBe(true);
	});

	it("leaves the hint unflagged when a write is refused", () => {
		const source: { hub: { n: number }; slot?: unknown } = { hub: { n: 1 } };

		Object.defineProperty(source, "slot", { value: undefined, writable: false, enumerable: true });

		const state = createMutableState(source);

		expect(() => {
			state.slot = state.hub;
		}).toThrow("trap returned falsish");

		expect(isPossiblyShared(state.hub)).toBe(false);
	});

	it("leaves the hint unflagged when the strictness join throws", () => {
		const loose = createMutableState({ node: { n: 1 } }, { strict: false });
		const strict = createMutableState<{ hub: { n: number }; slot?: unknown }>({ hub: { n: 1 } });

		expect(() => {
			strict.slot = loose.node;
		}).toThrow("strict");

		expect(isPossiblyShared(loose.node)).toBe(false);
		expect(isPossiblyShared(strict.hub)).toBe(false);
	});
});

describe("formation detection (index semantics)", () => {
	it("detects init-time aliasing at index build", () => {
		const shared = { n: 1 };
		const state = createMutableState({ a: shared, alias: shared });
		const index = createRouteIndex(state);

		expect(index.routesOf(state.a).map((path) => [...path])).toEqual([["a"], ["alias"]]);
		expect(index.sharedLives.has(rawTargetOf(state.a))).toBe(true);
	});

	it("detects cross-tick aliasing at index build", async () => {
		const state = createMutableState<{ a: { n: number }; alias?: { n: number } }>({ a: { n: 1 } });

		await Promise.resolve();
		await Promise.resolve();

		state.alias = state.a;

		const index = createRouteIndex(state);

		expect(index.routesOf(state.a).map((path) => [...path])).toEqual([["a"], ["alias"]]);
		expect(index.sharedLives.has(rawTargetOf(state.a))).toBe(true);
		expect(isPossiblyShared(state.a)).toBe(true);
	});

	it("isolates multi-state sharing as per-diff derivation", async () => {
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

		const indexA = createRouteIndex(stateA);
		const indexB = createRouteIndex(stateB);

		expect(indexA.routesOf(stateA.held).map((path) => [...path])).toEqual([["held"], ["alias"]]);
		expect(indexB.routesOf(stateB.held).map((path) => [...path])).toEqual([["held"], ["alias"]]);
		expect(indexA.routesOf(stateB)).toEqual([]);
		expect(indexB.routesOf(stateA)).toEqual([]);

		for (const flush of deferred) flush();

		expect(heardA).toHaveLength(1);
		expect(heardB).toHaveLength(1);
	});

	it("detects nested cycle formation on the live graph without a resident ledger", () => {
		const state = createMutableState<{ box: { n: number; self?: object } }>({ box: { n: 1 } });

		state.box.self = state.box;

		const index = createRouteIndex(state);

		expect(index.routesOf(state.box as object).map((path) => [...path])).toEqual([["box"], ["box", "self"]]);
		expect(isPossiblyShared(state.box)).toBe(true);
	});
});
