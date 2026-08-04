import { getUntracked } from "proxy-compare";
import { unstable_getInternalStates } from "valtio/vanilla";
import { getRegisteredWrapperTarget } from "./react/wrapperRegistry";

const isObjectLike = (value: unknown): value is object =>
	value !== null && (typeof value === "object" || typeof value === "function");

const targetRegistry = new WeakMap<object, object>();
const identityTokenRegistry = new WeakMap<object, object>();
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

		const entry = proxyStateMap.get(current);

		if (entry !== undefined) {
			const target = entry[0];

			if (target !== current) {
				current = target;

				continue;
			}
		}

		break;
	}

	return current;
}

/**
 * Returns a stable identity key for a value.
 *
 * @param value - Value to identify.
 * @returns Identity key.
 */
export function identify(value: object): object {
	const target = resolveIdentity(value);

	if (!isObjectLike(target)) return value;

	const existing = identityTokenRegistry.get(target);

	if (existing !== undefined) return existing;

	const token = Object.freeze({});

	identityTokenRegistry.set(target, token);

	return token;
}

/**
 * Returns whether two values share the same identity.
 *
 * @param first - First value.
 * @param second - Second value.
 * @returns True if they match.
 */
export function isSameIdentity(first: object, second: object): boolean {
	const resolvedFirst = resolveIdentity(first);
	const resolvedSecond = resolveIdentity(second);

	return resolvedFirst === resolvedSecond || (resolvedFirst !== resolvedFirst && resolvedSecond !== resolvedSecond);
}
