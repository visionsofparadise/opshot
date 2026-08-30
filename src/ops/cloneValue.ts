import { unstable_getInternalStates } from "valtio/vanilla";
import { isUntrackedEdge } from "../edges";
import { getRegisteredTarget } from "../identity";
import { segmentFor, walkDataEntries } from "../utils/dataEntries";
import { admissionLane } from "../valtio/classify";
import { isObjectLike } from "./predicates";
import type { Handle } from "../handle";
import type { OperationPath } from "./path";

const { proxyStateMap } = unstable_getInternalStates();

const isInstrumented = (value: object): boolean => proxyStateMap.has(value) || getRegisteredTarget(value) !== undefined;

export const isPlainArray = (value: unknown): value is Array<unknown> => Array.isArray(value);

export const isPlainObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" &&
	value !== null &&
	!Array.isArray(value) &&
	(admissionLane(value) === "tracked" || isInstrumented(value));

const isCloneable = (value: unknown): value is Record<string, unknown> | Array<unknown> =>
	typeof value === "object" && value !== null && (admissionLane(value) === "tracked" || isInstrumented(value));

export const cloneValue = (
	value: unknown,
	memo: WeakMap<object, unknown>,
	path: OperationPath,
	handle?: Handle,
): unknown => {
	if (!isCloneable(value)) return value;

	const cached = memo.get(value);

	if (cached !== undefined) return cached;

	const array = isPlainArray(value);
	const clone: object = array ? [] : {};

	Reflect.setPrototypeOf(clone, Reflect.getPrototypeOf(value));
	memo.set(value, clone);

	for (const entry of walkDataEntries(value)) {
		const entryValue = entry.value;

		if (isObjectLike(entryValue) && isUntrackedEdge(handle, value, segmentFor(value, entry.key), entryValue))
			continue;

		Reflect.set(clone, entry.key, cloneValue(entryValue, memo, path, handle));
	}

	if (array) Reflect.set(clone, "length", value.length);

	return clone;
};
