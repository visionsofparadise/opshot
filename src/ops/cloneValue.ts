import { unstable_getInternalStates } from "valtio/vanilla";
import { getRegisteredTarget } from "../identity";
import { pendingIgnore } from "../ignore";
import { pendingUnsafe } from "../unsafeTrack";
import { carriedOwnKeysOf } from "../utils/dataEntries";
import { admissionLane } from "../valtio/classify";
import type { OperationPath } from "./path";

const { refSet, proxyStateMap } = unstable_getInternalStates();

const isInstrumented = (value: object): boolean => proxyStateMap.has(value) || getRegisteredTarget(value) !== undefined;

export const isPlainArray = (value: unknown): value is Array<unknown> => Array.isArray(value) && !refSet.has(value);

export const isPlainObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" &&
	value !== null &&
	!Array.isArray(value) &&
	!pendingIgnore.has(value) &&
	(admissionLane(value) === "tracked" || isInstrumented(value));

export const isCloneable = (value: unknown): value is Record<string, unknown> | Array<unknown> =>
	typeof value === "object" &&
	value !== null &&
	!pendingIgnore.has(value) &&
	(admissionLane(value) === "tracked" || isInstrumented(value));

export const cloneValue = (value: unknown, memo: WeakMap<object, unknown>, path: OperationPath): unknown => {
	if (!isCloneable(value)) return value;

	const cached = memo.get(value);

	if (cached !== undefined) return cached;

	const array = isPlainArray(value);
	const clone: object = array ? [] : {};

	Reflect.setPrototypeOf(clone, Reflect.getPrototypeOf(value));
	memo.set(value, clone);

	for (const key of carriedOwnKeysOf(value)) {
		const descriptor = Reflect.getOwnPropertyDescriptor(value, key);

		if (!descriptor) continue;

		if ("value" in descriptor) {
			Object.defineProperty(clone, key, {
				...descriptor,
				value: cloneValue(descriptor.value, memo, path),
			});
		} else {
			Object.defineProperty(clone, key, descriptor);
		}
	}

	if (!array && admissionLane(value) === "dangerous") pendingUnsafe.add(clone);

	return clone;
};
