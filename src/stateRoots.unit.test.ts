import { createMutableState } from "./createMutableState";
import { isStateRoot, markStateRoot } from "./stateRoots";
import { unstable_getInternalStates } from "valtio/vanilla";

const { proxyStateMap } = unstable_getInternalStates();

const rawTargetOf = (value: object): object => proxyStateMap.get(value)?.[0] ?? value;

describe("stateRoots", () => {
	it("marks and reports state roots", () => {
		const target = {};

		expect(isStateRoot(target)).toBe(false);

		markStateRoot(target);

		expect(isStateRoot(target)).toBe(true);
	});

	it("createMutableState marks the raw root", () => {
		const state = createMutableState({ document: { title: "a" } });

		expect(isStateRoot(rawTargetOf(state))).toBe(true);
		expect(isStateRoot(rawTargetOf(state.document))).toBe(false);
	});
});
