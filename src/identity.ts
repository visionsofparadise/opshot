import { rawOf } from "./node";
import { isObjectLike } from "./utils/predicates";

const readProxyTargets = new WeakMap<object, object>();

interface IdentityRecord {
	token?: object;
	id?: number;
}

const identityRecords = new WeakMap<WeakKey, IdentityRecord>();
let nextInternId = 0;

export const registerReadProxyTarget = (readProxy: object, target: object): void => {
	readProxyTargets.set(readProxy, target);
};

export const getRegisteredReadProxyTarget = (readProxy: object): object | undefined => readProxyTargets.get(readProxy);

function resolveIdentity(value: object | symbol): object | symbol;

function resolveIdentity(value: unknown): unknown;

function resolveIdentity(value: unknown): unknown {
	let current = value;

	while (isObjectLike(current)) {
		const readTarget = getRegisteredReadProxyTarget(current);

		if (readTarget !== undefined && readTarget !== current) {
			current = readTarget;

			continue;
		}

		const raw = rawOf(current);

		if (raw !== current) {
			current = raw;

			continue;
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
