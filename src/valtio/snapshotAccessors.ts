import { markToTrack } from "proxy-compare";
import { unstable_getInternalStates } from "valtio/vanilla";
import { registerSnapshotCopy } from "../identity";
import { isUnsafeTracked, unsafeTrack } from "../unsafeTrack";
import { carriedOwnKeys } from "../utils/dataEntries";

const { refSet, proxyStateMap, snapCache } = unstable_getInternalStates();

export const createSnapshotPreservingAccessors = <T extends object>(target: T, version: number): T => {
	const cached = snapCache.get(target);

	if (cached?.[0] === version) {
		const cachedSnapshot = cached[1] as T;

		registerSnapshotCopy(cachedSnapshot, target);

		return cachedSnapshot;
	}

	const snap: object = Array.isArray(target) ? [] : (Object.create(Reflect.getPrototypeOf(target)) as object);

	registerSnapshotCopy(snap, target);
	markToTrack(snap, true);
	snapCache.set(target, [version, snap]);

	for (const key of carriedOwnKeys(target)) {
		if (Object.getOwnPropertyDescriptor(snap, key)) continue;

		const descriptor = Reflect.getOwnPropertyDescriptor(target, key);

		if (!descriptor) continue;

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
			if (refSet.has(value)) {
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

	if (isUnsafeTracked(target)) unsafeTrack(snap);

	return snap as T;
};
