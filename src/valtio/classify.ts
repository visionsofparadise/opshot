import { unstable_getInternalStates } from "valtio/vanilla";
import { isUnsafeTracked } from "../unsafeTrack";

const { refSet } = unstable_getInternalStates();

export type ValueKind = "plain" | "plainArray" | "arraySubclass" | "cleanClass" | "privateClass" | "nativeClass";

const sourceCache = new WeakMap<Function, string>();

const readSource = (constructor: Function): string => {
	const cached = sourceCache.get(constructor);

	if (cached !== undefined) return cached;

	const source = Function.prototype.toString.call(constructor);

	sourceCache.set(constructor, source);

	return source;
};

const classifyChain = (initialConstructor: unknown): ValueKind => {
	let sawNativeSource = false;
	let current = initialConstructor;

	while (typeof current === "function" && current !== Object && current !== Array && current !== Function.prototype) {
		const source = readSource(current);

		if (source.includes("#")) return "privateClass";

		if (source.includes("[native code]")) sawNativeSource = true;

		current = Reflect.getPrototypeOf(current);
	}

	return sawNativeSource ? "nativeClass" : "cleanClass";
};

export function classifyValue(value: object): ValueKind {
	const prototype: unknown = Object.getPrototypeOf(value);

	if (Array.isArray(value))
		return prototype === Array.prototype || prototype === null ? "plainArray" : "arraySubclass";

	if (prototype === Object.prototype || prototype === null) return "plain";

	return classifyChain(value.constructor);
}

export function hasOwnEnumerableFunction(value: object): boolean {
	for (const key of Reflect.ownKeys(value)) {
		const descriptor = Object.getOwnPropertyDescriptor(value, key);

		if (!descriptor?.enumerable || !("value" in descriptor)) continue;

		if (typeof descriptor.value === "function") return true;
	}

	return false;
}

export type AdmissionLane = "track" | "leaf" | "reject";

export function admissionLane(value: unknown): AdmissionLane {
	if (typeof value !== "object" || value === null) return "leaf";

	if (refSet.has(value)) return "leaf";

	if (isUnsafeTracked(value)) return "track";

	const kind = classifyValue(value);

	if ((kind === "plain" || kind === "plainArray" || kind === "cleanClass") && Object.isFrozen(value)) return "leaf";

	if (kind === "plain" || kind === "plainArray") return "track";

	if (kind === "cleanClass" && !hasOwnEnumerableFunction(value)) return "track";

	return "reject";
}

export function isTrackable(value: unknown): boolean {
	return admissionLane(value) === "track";
}
