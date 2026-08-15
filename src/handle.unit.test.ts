import { unstable_getInternalStates } from "valtio/vanilla";
import { createMutableState } from "./createMutableState";
import { handleOf, registerHandle, type Handle } from "./handle";

const { proxyStateMap } = unstable_getInternalStates();

const rawTargetOf = (value: object): object => proxyStateMap.get(value)?.[0] ?? value;

describe("handleOf", () => {
	it("returns undefined for an unregistered object", () => {
		expect(handleOf({})).toBeUndefined();
	});

	it("returns the registered object for that target", () => {
		const target = {};
		const registered: Handle = {
			proxy: { root: target },
			lastSnapshot: target,
			hasPendingWrites: false,
			isFlushScheduled: false,
			isFlushHeld: false,
			flushGeneration: 0,
			subscribers: new Map(),
		};

		registerHandle(target, registered);

		expect(handleOf(target)).toBe(registered);
	});
});

describe("createMutableState registration", () => {
	it("registers the raw target of a tracked factory return and does not put root on it", () => {
		const state = createMutableState({ n: 1 });
		const handle = handleOf(rawTargetOf(state));

		expect(handle).toBeDefined();
		expect(handle?.proxy.root).toBe(state);
		expect(Object.hasOwn(state, "root")).toBe(false);
	});

	it("does not register a frozen factory argument", () => {
		const frozen = Object.freeze({ n: 1 });

		createMutableState(frozen);

		expect(handleOf(frozen)).toBeUndefined();
	});
});
