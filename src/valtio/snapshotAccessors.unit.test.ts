import { snapshot, unstable_getInternalStates } from "valtio/vanilla";

import { createMutableState } from "../createMutableState";
import { getRegisteredTarget, isSameIdentity } from "../identity";
import { batch } from "../batch";
import { createSnapshotPreservingAccessors } from "./snapshotAccessors";

const { proxyStateMap, snapCache } = unstable_getInternalStates();

describe("snapshotAccessors: freeze occupancy", () => {
	it("carries a live-frozen child by reference like an admission-time freeze", () => {
		const state = createMutableState({ child: { n: 1 } });

		Object.freeze(state.child);

		expect(snapshot(state).child).toBe(state.child);

		const frozen = Object.freeze({ n: 1 });

		expect(snapshot(createMutableState({ child: frozen })).child).toBe(frozen);
	});

	it("keeps a getter through a snapshot cache hit and recomputes after writes", () => {
		interface Temperature {
			celsius: number;
			readonly fahrenheit: number;
		}

		const state = createMutableState<Temperature>({
			celsius: 0,
			get fahrenheit() {
				return (this.celsius * 9) / 5 + 32;
			},
		});
		const first = snapshot(state);

		expect(snapshot(state)).toBe(first);
		expect(first.fahrenheit).toBe(32);
		expect(Object.getOwnPropertyDescriptor(first, "fahrenheit")?.get).toBeTypeOf("function");

		batch(() => {
			state.celsius = 20;
		});

		const second = snapshot(state);

		expect(second).not.toBe(first);
		expect(second.fahrenheit).toBe(68);
		expect(Object.getOwnPropertyDescriptor(second, "fahrenheit")?.get).toBeTypeOf("function");
	});

	it("re-registers a cached snapshot that lost its identity registration", () => {
		const state = createMutableState({ n: 1 });
		const entry = proxyStateMap.get(state);

		if (entry === undefined) throw new Error("snapshotAccessors test: missing proxy state");

		const [target, versionOf] = entry;
		const orphan = { n: 1 };

		snapCache.set(target, [versionOf(), orphan]);

		expect(getRegisteredTarget(orphan)).toBeUndefined();

		const cached = createSnapshotPreservingAccessors(target, versionOf());

		expect(cached).toBe(orphan);
		expect(getRegisteredTarget(orphan)).toBe(target);
		expect(isSameIdentity(cached, state)).toBe(true);
	});

	it("keeps a trailing-hole array's length on the snapshot", () => {
		const list = [1];

		list.length = 3;

		const snap = snapshot(createMutableState({ list })).list;

		expect(snap).toHaveLength(3);
		expect(Object.hasOwn(snap, 0)).toBe(true);
		expect(Object.hasOwn(snap, 1)).toBe(false);
		expect(Object.hasOwn(snap, 2)).toBe(false);
	});
});
