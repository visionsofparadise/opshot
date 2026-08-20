import { markToTrack } from "proxy-compare";
import { unstable_getInternalStates } from "valtio/vanilla";
import { getRegisteredTarget, registerSnapshotCopy } from "../identity";
import { carriedOwnKeysOf } from "../utils/dataEntries";
import { admissionLane } from "./classify";

const { proxyStateMap, snapCache } = unstable_getInternalStates();

class MissingOwnDescriptorError extends Error {
	constructor() {
		super("opshot: carried own key has no property descriptor");
		this.name = "MissingOwnDescriptorError";
	}
}

export const createSnapshotPreservingAccessors = <T extends object>(target: T, version: number): T => {
	const cached = snapCache.get(target);

	if (cached?.[0] === version) {
		const cachedSnapshot = cached[1] as T;

		for (const key of carriedOwnKeysOf(target)) {
			const value: unknown = Reflect.get(target, key);

			if (typeof value !== "object" || value === null) continue;

			if (admissionLane(value) !== "untracked") continue;

			if (Reflect.get(cachedSnapshot, key) === value) continue;

			const descriptor = Reflect.getOwnPropertyDescriptor(target, key);

			if (descriptor === undefined || descriptor.get !== undefined || descriptor.set !== undefined) continue;

			Object.defineProperty(cachedSnapshot, key, {
				value,
				enumerable: descriptor.enumerable,
				configurable: true,
			});
			markToTrack(value, false);
		}

		if (getRegisteredTarget(cachedSnapshot) === undefined) {
			registerSnapshotCopy(cachedSnapshot, target);
		}

		return cachedSnapshot;
	}

	const snap: object = Array.isArray(target) ? [] : (Object.create(Reflect.getPrototypeOf(target)) as object);

	registerSnapshotCopy(snap, target);
	markToTrack(snap, true);
	snapCache.set(target, [version, snap]);

	for (const key of carriedOwnKeysOf(target)) {
		if (Object.getOwnPropertyDescriptor(snap, key)) continue;

		const descriptor = Reflect.getOwnPropertyDescriptor(target, key);

		if (descriptor === undefined) throw new MissingOwnDescriptorError();

		if (descriptor.get || descriptor.set) {
			Object.defineProperty(snap, key, {
				get: descriptor.get,
				set: descriptor.set,
				enumerable: descriptor.enumerable,
				configurable: true,
			});

			continue;
		}

		const value: unknown = Reflect.get(target, key);
		const snapshotDescriptor: PropertyDescriptor = { value, enumerable: descriptor.enumerable, configurable: true };

		if (typeof value === "object" && value !== null) {
			if (admissionLane(value) === "untracked") {
				markToTrack(value, false);
			} else {
				const childState = proxyStateMap.get(value);

				if (childState)
					snapshotDescriptor.value = createSnapshotPreservingAccessors(childState[0], childState[1]());
			}
		}

		Object.defineProperty(snap, key, snapshotDescriptor);
	}

	if (Array.isArray(target) && (snap as Array<unknown>).length !== (target as Array<unknown>).length) {
		(snap as Array<unknown>).length = (target as Array<unknown>).length;
	}

	return snap as T;
};
