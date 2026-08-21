import { unstable_getInternalStates } from "valtio/vanilla";
import { getRegisteredTarget } from "../identity";
import { carriedOwnKeysOf } from "../utils/dataEntries";
import { admissionLane } from "../valtio/classify";
import type { OperationPath } from "./path";

const { proxyStateMap } = unstable_getInternalStates();

class MissingOwnDescriptorError extends Error {
	constructor() {
		super("opshot: carried own key has no property descriptor");
		this.name = "MissingOwnDescriptorError";
	}
}

const isInstrumented = (value: object): boolean => proxyStateMap.has(value) || getRegisteredTarget(value) !== undefined;

export const isPlainArray = (value: unknown): value is Array<unknown> => Array.isArray(value);

export const isPlainObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" &&
	value !== null &&
	!Array.isArray(value) &&
	(admissionLane(value) === "tracked" || isInstrumented(value));

const isCloneable = (value: unknown): value is Record<string, unknown> | Array<unknown> =>
	typeof value === "object" &&
	value !== null &&
	(Object.isFrozen(value) || admissionLane(value) === "tracked" || isInstrumented(value));

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

		if (descriptor === undefined) throw new MissingOwnDescriptorError();

		if ("value" in descriptor) {
			Object.defineProperty(clone, key, {
				...descriptor,
				value: cloneValue(descriptor.value, memo, path),
			});
		} else {
			Object.defineProperty(clone, key, descriptor);
		}
	}

	if (Object.isFrozen(value)) Object.freeze(clone);

	return clone;
};
