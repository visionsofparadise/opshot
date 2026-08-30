import { getUntracked } from "proxy-compare";
import { unstable_getInternalStates } from "valtio/vanilla";

const isObjectLike = (value: unknown): value is object =>
	value !== null && (typeof value === "object" || typeof value === "function");

const targetRegistry = new WeakMap<object, object>();
const readProxyTargets = new WeakMap<object, object>();

interface IdentityRecord {
	token?: object;
	id?: number;
}

const identityRecords = new WeakMap<WeakKey, IdentityRecord>();
let nextInternId = 0;

const { proxyStateMap } = unstable_getInternalStates();

export function registerSnapshotCopy(copy: object, target: object): void {
	targetRegistry.set(copy, target);
}

export function getRegisteredTarget(copy: object): object | undefined {
	return targetRegistry.get(copy);
}

export const storageIdentityOf = (value: object): object => {
	const registered = targetRegistry.get(value);
	const object = registered ?? value;

	return proxyStateMap.get(object)?.[0] ?? object;
};

export const registerReadProxyTarget = (readProxy: object, target: object): void => {
	readProxyTargets.set(readProxy, target);
};

export const getRegisteredReadProxyTarget = (readProxy: object): object | undefined => readProxyTargets.get(readProxy);

export function peelIdentityLayer(current: object): object | undefined {
	const untracked = getUntracked(current);

	if (untracked !== null && untracked !== current) return untracked;

	const readProxyTarget = getRegisteredReadProxyTarget(current);

	if (readProxyTarget !== undefined && readProxyTarget !== current) return readProxyTarget;

	const registeredTarget = targetRegistry.get(current);

	if (registeredTarget !== undefined && registeredTarget !== current) return registeredTarget;

	return undefined;
}

export function resolveIdentity(value: object | symbol): object | symbol;
export function resolveIdentity(value: unknown): unknown;
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

const recordFor = (key: WeakKey): IdentityRecord => {
	let record = identityRecords.get(key);

	if (record === undefined) {
		record = {};
		identityRecords.set(key, record);
	}

	return record;
};

/**
 * Returns a stable identity key for a value.
 *
 * @param value - Value to identify.
 * @returns Identity key.
 */
export function identify(value: object): object {
	const target = resolveIdentity(value);

	if (!isObjectLike(target)) return value;

	const record = recordFor(target);

	if (record.token !== undefined) return record.token;

	const token = Object.freeze({});

	record.token = token;

	return token;
}

export const internIdentity = (key: object | symbol): number => {
	const resolved = resolveIdentity(key);
	const record = recordFor(resolved);

	if (record.id !== undefined) return record.id;

	const id = nextInternId;

	nextInternId += 1;
	record.id = id;

	return id;
};

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

	return resolvedFirst === resolvedSecond;
}
