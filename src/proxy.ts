import { assertAdmissible } from "./admission";
import { currentMeta } from "./batch";
import { rejectionError } from "./boundaryErrors";
import { classifyValue } from "./classify";
import { attach, detach, evict, isTrackedEntry } from "./edges";
import { recordOperation } from "./emit/window";
import { handlesOf, proxyOf, recordOf, rawOf } from "./node";
import { isUnsafeMarked } from "./unsafeTrack";
import { isObjectLike } from "./utils/predicates";
import type { DataEntry } from "./utils/dataEntries";

const writesThroughAccessor = (target: object, property: string | symbol): boolean => {
	let holder: object | null = target;

	while (holder !== null) {
		const descriptor = Reflect.getOwnPropertyDescriptor(holder, property);

		if (descriptor !== undefined) return !("value" in descriptor);

		holder = Reflect.getPrototypeOf(holder);
	}

	return false;
};

const proxied = (value: unknown): unknown => (isObjectLike(value) ? (recordOf(value)?.proxy ?? value) : value);

const truncatedOwnEntriesOf = (target: object, next: unknown): Array<DataEntry> => {
	if (!Array.isArray(target)) return [];

	const coercible = next === null || (typeof next !== "object" && typeof next !== "function");
	const newLength = coercible ? Number(next) : Number.NaN;

	if (!Number.isInteger(newLength) || newLength < 0 || newLength >= target.length) return [];

	const truncated = new Array<DataEntry>();

	for (let index = newLength; index < target.length; index += 1) {
		const key = String(index);
		const descriptor = Reflect.getOwnPropertyDescriptor(target, key);

		if (descriptor === undefined || !("value" in descriptor)) continue;

		truncated.push({
			key,
			value: descriptor.value,
			writable: descriptor.writable === true,
		});
	}

	return truncated;
};

const ownDataDescriptor = (
	target: object,
	key: string,
): { hadPrevious: boolean; previous: unknown; writable: boolean } => {
	const descriptor = Reflect.getOwnPropertyDescriptor(target, key);

	if (descriptor === undefined || !("value" in descriptor)) {
		return { hadPrevious: false, previous: undefined, writable: false };
	}

	return { hadPrevious: true, previous: descriptor.value, writable: descriptor.writable === true };
};

export const handler: ProxyHandler<object> = {
	get(target, key, receiver) {
		const value: unknown = Reflect.get(target, key, receiver);
		const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
		const locked = descriptor?.writable === false && descriptor.configurable === false;

		if (locked || !isObjectLike(value)) return value;

		return recordOf(value)?.proxy ?? value;
	},

	set(target, key, value, receiver) {
		if (typeof key !== "string" || writesThroughAccessor(target, key)) {
			return Reflect.set(target, key, value, receiver);
		}

		const { hadPrevious, previous, writable: previousWritable } = ownDataDescriptor(target, key);
		const resolved: unknown = isObjectLike(value) ? rawOf(value) : value;
		const handles = handlesOf(target);
		const truncated = truncatedOwnEntriesOf(target, resolved);

		for (const handle of handles) {
			const membership = recordOf(target)?.memberships.get(handle);

			if (membership === undefined || membership.exempt) continue;

			if (isObjectLike(resolved) && typeof resolved !== "function") {
				assertAdmissible(handle, resolved, [key], isUnsafeMarked(resolved));
			} else if (typeof resolved === "function") {
				const kind = classifyValue(target);

				if (kind !== "plain" && kind !== "plainArray") throw rejectionError(target, kind, [key]);
			}
		}

		const result = Reflect.set(target, key, resolved, receiver);

		if (!result) return result;

		const newDescriptor = Reflect.getOwnPropertyDescriptor(target, key);
		const newEntry: DataEntry = {
			key,
			value: resolved,
			writable: newDescriptor?.writable === true,
		};
		const meta = currentMeta();
		const node = proxyOf(target);

		for (const handle of handles) {
			for (const entry of truncated) {
				if (isTrackedEntry(handle, target, entry)) detach(handle, entry.value);

				recordOperation(handle, target, {
					node,
					key: entry.key,
					meta,
					before: proxied(entry.value),
					hasBefore: true,
					hasAfter: false,
				});
			}

			if (
				hadPrevious &&
				isObjectLike(previous) &&
				previous !== resolved &&
				isTrackedEntry(handle, target, { key, value: previous, writable: previousWritable })
			) {
				detach(handle, previous);
			}

			if (isObjectLike(resolved) && isTrackedEntry(handle, target, newEntry)) {
				attach(handle, target, resolved);
			}

			recordOperation(handle, target, {
				node,
				key,
				meta,
				before: proxied(previous),
				after: proxied(resolved),
				hasBefore: hadPrevious,
				hasAfter: true,
			});
		}

		return result;
	},

	deleteProperty(target, key) {
		if (typeof key !== "string") return Reflect.deleteProperty(target, key);

		const { hadPrevious, previous, writable } = ownDataDescriptor(target, key);
		const result = Reflect.deleteProperty(target, key);

		if (!result || !hadPrevious) return result;

		const meta = currentMeta();
		const node = proxyOf(target);

		for (const handle of handlesOf(target)) {
			if (isObjectLike(previous) && isTrackedEntry(handle, target, { key, value: previous, writable })) {
				detach(handle, previous);
			}

			recordOperation(handle, target, {
				node,
				key,
				meta,
				before: proxied(previous),
				hasBefore: true,
				hasAfter: false,
			});
		}

		return result;
	},

	preventExtensions(target) {
		for (const handle of handlesOf(target)) evict(handle, target);

		return Reflect.preventExtensions(target);
	},

	defineProperty(target, key, descriptor) {
		return Reflect.defineProperty(target, key, descriptor);
	},

	setPrototypeOf(target, prototype) {
		return Reflect.setPrototypeOf(target, prototype);
	},

	has(target, key) {
		return Reflect.has(target, key);
	},

	ownKeys(target) {
		return Reflect.ownKeys(target);
	},

	getOwnPropertyDescriptor(target, key) {
		return Reflect.getOwnPropertyDescriptor(target, key);
	},
};
