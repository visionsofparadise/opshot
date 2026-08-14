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

export type AdmissionLane = "track" | "leaf" | "reject";

export type AdmissionDecision =
	| { readonly lane: "track" | "leaf" }
	| { readonly lane: "reject"; readonly kind: Exclude<ValueKind, "plain" | "plainArray"> };

export function admissionDecision(value: unknown): AdmissionDecision {
	if (typeof value !== "object" || value === null) return { lane: "leaf" };

	if (refSet.has(value)) return { lane: "leaf" };

	if (Object.isFrozen(value)) return { lane: "leaf" };

	if (isUnsafeTracked(value)) return { lane: "track" };

	const kind = classifyValue(value);

	if (kind === "plain" || kind === "plainArray" || kind === "cleanClass") return { lane: "track" };

	return { lane: "reject", kind };
}

export function admissionLane(value: unknown): AdmissionLane {
	return admissionDecision(value).lane;
}

export function isTrackable(value: unknown): boolean {
	return admissionDecision(value).lane === "track";
}
