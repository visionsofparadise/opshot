import { unstable_getInternalStates } from "valtio/vanilla";
import { isUnsafeTracked, unsafeTrack } from "../unsafeTrack";
import { carriedOwnKeysOf } from "../utils/dataEntries";
import { isTrackable } from "../valtio/classify";
import { createOperationPath, formatOperationPath, type OperationPath } from "./path";

const { refSet } = unstable_getInternalStates();

export const isPlainArray = (value: unknown): value is Array<unknown> => Array.isArray(value) && !refSet.has(value);

export const isPlainObject = (value: unknown): value is Record<string, unknown> =>
	isTrackable(value) && !Array.isArray(value);

export const isCloneable = (value: unknown): value is Record<string, unknown> | Array<unknown> => isTrackable(value);

export class CyclicValueError extends Error {
	readonly path: OperationPath;

	constructor(path: OperationPath) {
		super(`opshot: cyclic value at ${formatOperationPath(path)}; use ignore() for back-linked structures, or ids`);
		this.name = "CyclicValueError";
		this.path = createOperationPath(path);
	}
}

export const cyclicError = (path: OperationPath): CyclicValueError => new CyclicValueError(path);

export const getCyclicPath = (error: unknown): OperationPath | undefined =>
	error instanceof CyclicValueError ? error.path : undefined;

const CLONE_IN_PROGRESS = Symbol("opshot.cloneValue.inProgress");

export const cloneValue = (value: unknown, memo: WeakMap<object, unknown>, path: OperationPath): unknown => {
	if (!isCloneable(value)) return value;

	const cached = memo.get(value);

	if (cached === CLONE_IN_PROGRESS) throw cyclicError(path);

	if (cached !== undefined) return cached;

	memo.set(value, CLONE_IN_PROGRESS);

	const array = isPlainArray(value);
	const clone: object = array ? [] : {};

	Reflect.setPrototypeOf(clone, Reflect.getPrototypeOf(value));

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

	memo.set(value, clone);

	if (isUnsafeTracked(value)) unsafeTrack(clone);

	return clone;
};
