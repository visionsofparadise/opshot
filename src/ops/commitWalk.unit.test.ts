import { createMutableState } from "../createMutableState";
import { subscribe } from "../subscribe";
import { unstable_getInternalStates } from "valtio/vanilla";
import {
	absorbFormationPulse,
	clearFormationCandidates,
	clearFormationPulse,
	externalRoutesOf,
	flagFormationCandidate,
	formationCandidatesOf,
	resolveCandidates,
	takeFormationCandidates,
} from "./commitWalk";
import { createOperationPath } from "./path";

const { proxyStateMap } = unstable_getInternalStates();

const rawTargetOf = (value: object): object => proxyStateMap.get(value)?.[0] ?? value;

describe("resolveCandidates", () => {
	afterEach(() => {
		clearFormationCandidates();
	});

	it("returns the first-encounter route as canonical and every found route", () => {
		const shared = { n: 1 };
		const state = createMutableState({
			a: { b: shared },
			b: shared,
			c: shared,
		});

		const routes = [...resolveCandidates(state, new Set([state.a.b as object])).values()];

		expect(routes).toHaveLength(1);
		expect(routes[0]?.map((path) => [...path])).toEqual([["a", "b"], ["b"], ["c"]]);
	});

	it("returns an empty map when there are no candidates", () => {
		const state = createMutableState({ a: { n: 1 } });

		expect(resolveCandidates(state, new Set()).size).toBe(0);
	});

	it("returns no entry for a detached candidate", () => {
		const state = createMutableState({ a: { n: 1 } });
		const detached = { n: 2 };

		expect(resolveCandidates(state, new Set([detached])).size).toBe(0);
	});

	it("returns no entry for a cross-graph candidate", () => {
		const shared = { n: 1 };
		const stateA = createMutableState({ held: shared });
		const stateB = createMutableState({ other: { n: 2 } });

		expect(resolveCandidates(stateB, new Set([stateA.held as object])).size).toBe(0);
	});

	it("is cycle-safe and records every simple route to the cycle node", () => {
		const state = createMutableState<{ box: { n: number; self?: object } }>({ box: { n: 1 } });

		state.box.self = state.box;

		const routes = [...resolveCandidates(state, new Set([state.box as object])).values()];

		expect(routes).toHaveLength(1);
		expect(routes[0]?.map((path) => [...path])).toEqual([["box"], ["box", "self"]]);
	});

	it("externalRoutesOf drops routes under the formation path", () => {
		const routes = [createOperationPath(["a", "b"]), createOperationPath(["b2"]), createOperationPath(["b2", "x"])];

		expect(externalRoutesOf(routes, createOperationPath(["b2"])).map((path) => [...path])).toEqual([["a", "b"]]);
	});

	it("flags formation candidates onto the host state's ledger", () => {
		const state = createMutableState({ shared: { n: 1 } });

		expect(formationCandidatesOf(state).size).toBe(0);

		flagFormationCandidate(state.shared, state);

		expect(formationCandidatesOf(state).size).toBe(1);
		expect(resolveCandidates(state, formationCandidatesOf(state)).size).toBe(1);
	});

	it("scopes formation candidates per state and take clears only that state", () => {
		const stateA = createMutableState({ shared: { n: 1 } });
		const stateB = createMutableState({ other: { n: 2 } });

		flagFormationCandidate(stateA.shared, stateA);
		flagFormationCandidate(stateB.other, stateB);

		expect(formationCandidatesOf(stateA).size).toBe(1);
		expect(formationCandidatesOf(stateB).size).toBe(1);

		const takenA = takeFormationCandidates(stateA);

		expect(takenA.size).toBe(1);
		expect(formationCandidatesOf(stateA).size).toBe(0);
		expect(formationCandidatesOf(stateB).size).toBe(1);
		expect(takeFormationCandidates(stateB).size).toBe(1);
		expect(formationCandidatesOf(stateB).size).toBe(0);
	});

	it("nested-host flags land on a pulse until absorb copies them onto a root ledger", () => {
		const state = createMutableState({ box: { n: 1 } });
		const nestedHost = rawTargetOf(state.box);

		flagFormationCandidate(state.box, nestedHost);

		expect(formationCandidatesOf(state).size).toBe(0);

		absorbFormationPulse(state);

		expect(formationCandidatesOf(state).size).toBe(1);

		clearFormationPulse();
		expect(takeFormationCandidates(state).size).toBe(1);
	});

	it("nested bare cycle formation reaches the root ledger via notify absorb", () => {
		const state = createMutableState<{ box: { n: number; self?: object } }>({ box: { n: 1 } });
		const heard = new Array<unknown>();

		subscribe(state, (ops) => {
			heard.push(ops);
		});

		state.box.self = state.box;

		expect(state.box.self).toBe(state.box);
		expect(formationCandidatesOf(state).size).toBe(1);
	});
});
