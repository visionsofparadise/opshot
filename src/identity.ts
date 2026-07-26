import { getUntracked } from "proxy-compare";
import { unstable_getInternalStates } from "valtio/vanilla";
import { getRegisteredWrapperTarget } from "./react/wrapperRegistry";

const targetRegistryKey = Symbol.for("opshot.targets");
const identityTokenRegistryKey = Symbol.for("opshot.identityTokens");

const fallbackTargetRegistry = new WeakMap<object, object>();
const fallbackIdentityTokenRegistry = new WeakMap<object, object>();

const isObjectLike = (value: unknown): value is object =>
	value !== null && (typeof value === "object" || typeof value === "function");
const isRegistry = (value: unknown): value is WeakMap<object, object> =>
	value instanceof WeakMap && Object.getPrototypeOf(value) === WeakMap.prototype;

const getGlobalRegistry = (key: symbol, fallback: WeakMap<object, object>): WeakMap<object, object> => {
	try {
		const existing: unknown = Reflect.get(globalThis, key);

		if (isRegistry(existing)) return existing;

		const registry = new WeakMap<object, object>();

		if (!Reflect.defineProperty(globalThis, key, { value: registry })) return fallback;

		return registry;
	} catch {
		return fallback;
	}
};

const targetRegistry = getGlobalRegistry(targetRegistryKey, fallbackTargetRegistry);
const identityTokenRegistry = getGlobalRegistry(identityTokenRegistryKey, fallbackIdentityTokenRegistry);
const { proxyStateMap } = unstable_getInternalStates();

export function registerSnapshotCopy(copy: object, target: object): void {
	targetRegistry.set(copy, target);
}

export function getRegisteredTarget(copy: object): object | undefined {
	return targetRegistry.get(copy);
}

export function peelIdentityLayer(current: object): object | undefined {
	const untracked = getUntracked(current);

	if (untracked !== null && untracked !== current) return untracked;

	const wrapperTarget = getRegisteredWrapperTarget(current);

	if (wrapperTarget !== undefined && wrapperTarget !== current) return wrapperTarget;

	const registeredTarget = targetRegistry.get(current);

	if (registeredTarget !== undefined && registeredTarget !== current) return registeredTarget;

	return undefined;
}

export function resolveIdentity(value: unknown): unknown {
	let current = value;

	while (isObjectLike(current)) {
		const peeled = peelIdentityLayer(current);

		if (peeled !== undefined) {
			current = peeled;

			continue;
		}

		const proxyState = proxyStateMap.get(current);

		if (proxyState !== undefined && proxyState[0] !== current) {
			current = proxyState[0];

			continue;
		}

		break;
	}

	return current;
}

export function identify(value: object): object {
	const target = resolveIdentity(value);

	if (!isObjectLike(target)) return value;

	const existing = identityTokenRegistry.get(target);

	if (existing !== undefined) return existing;

	const token = Object.freeze({});

	identityTokenRegistry.set(target, token);

	return token;
}

export function isSameIdentity(first: object, second: object): boolean {
	const resolvedFirst = resolveIdentity(first);
	const resolvedSecond = resolveIdentity(second);

	return resolvedFirst === resolvedSecond || (resolvedFirst !== resolvedFirst && resolvedSecond !== resolvedSecond);
}
