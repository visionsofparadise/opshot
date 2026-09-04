import { currentMeta } from "./batch";
import { rejectionError } from "./boundaryErrors";
import { classifyValue } from "./classify";
import { attach, detach, evict, isTrackedEntry } from "./edges";
import { recordOperation } from "./emit/window";
import { membershipsOf, proxyOf, recordOf, rawOf, type Membership } from "./node";
import { isObjectLike } from "./utils/predicates";
import type { Handle } from "./handle";
import type { DataEntry } from "./utils/dataEntries";

interface MembershipWrite {
	readonly handle: Handle;
	readonly membership: Membership;
	readonly hadKey: boolean;
}

const prototypeFunctionOf = (target: object, key: string | symbol): Function | undefined => {
	for (let holder = Reflect.getPrototypeOf(target); holder !== null; holder = Reflect.getPrototypeOf(holder)) {
		const descriptor = Reflect.getOwnPropertyDescriptor(holder, key);

		if (descriptor === undefined) continue;

		const method: unknown = "value" in descriptor ? descriptor.value : undefined;

		return typeof method === "function" ? method : undefined;
	}

	return undefined;
};

const isRideAlongKey = (target: object, key: string): boolean => {
	if (key === "__proto__") return true;

	if (key === "length") return false;

	const descriptor = Reflect.getOwnPropertyDescriptor(target, key);

	return descriptor?.enumerable === false;
};

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

const ownDataDescriptor = (target: object, key: string): { hadPrevious: boolean; previous: unknown } => {
	const descriptor = Reflect.getOwnPropertyDescriptor(target, key);

	if (descriptor === undefined || !("value" in descriptor)) return { hadPrevious: false, previous: undefined };

	return { hadPrevious: true, previous: descriptor.value };
};

export const handler: ProxyHandler<object> = {
	get(target, key, receiver) {
		const value: unknown = Reflect.get(target, key, receiver);
		const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
		const locked = descriptor?.writable === false && descriptor.configurable === false;

		if (locked || !isObjectLike(value)) return value;

		if (typeof value === "function") {
			const method = prototypeFunctionOf(target, key);
			const kind = classifyValue(target);

			if (method !== undefined && value === method && (kind === "nativeClass" || kind === "privateClass")) {
				const bound: unknown = Function.prototype.bind.call(method, target);

				return typeof bound === "function" ? bound : value;
			}

			return value;
		}

		return recordOf(value)?.proxy ?? value;
	},

	set(target, key, value, receiver) {
		if (typeof key !== "string" || writesThroughAccessor(target, key) || isRideAlongKey(target, key)) {
			return Reflect.set(target, key, value, receiver);
		}

		const { hadPrevious, previous } = ownDataDescriptor(target, key);
		const resolved: unknown = isObjectLike(value) ? rawOf(value) : value;
		const memberships: Array<MembershipWrite> = membershipsOf(target).map(([handle, membership]) => ({
			handle,
			membership,
			hadKey: membership.keys.has(key),
		}));
		const truncated = key === "length" ? truncatedOwnEntriesOf(target, resolved) : [];
		const previousLength = Array.isArray(target) ? target.length : undefined;

		if (typeof resolved === "function" && memberships.some(({ membership }) => !membership.exempt)) {
			const kind = classifyValue(target);

			if (kind !== "plain" && kind !== "plainArray") throw rejectionError(target, kind, [key]);
		}

		const incoming: object | undefined =
			resolved !== previous && isTrackedEntry(resolved, true) ? resolved : undefined;
		let rollBack: (() => void) | undefined;

		if (incoming !== undefined) {
			const started = new Array<MembershipWrite>();

			rollBack = () => {
				for (const { handle, membership, hadKey } of started) {
					detach(handle, incoming);

					if (!hadKey) membership.keys.delete(key);
				}
			};

			try {
				for (const write of memberships) {
					started.push(write);
					attach(write.handle, target, key, incoming, [key]);
				}
			} catch (error) {
				rollBack();

				throw error;
			}
		}

		const result = Reflect.set(target, key, resolved, receiver);

		if (!result) {
			rollBack?.();

			return result;
		}

		const meta = currentMeta();
		const node = proxyOf(target);

		for (const { handle, membership, hadKey } of memberships) {
			for (const entry of truncated) {
				if (membership.keys.delete(entry.key) && isObjectLike(entry.value)) detach(handle, entry.value);

				recordOperation(handle, target, {
					node,
					key: entry.key,
					meta,
					before: proxied(entry.value),
					hasBefore: true,
					hasAfter: false,
				});
			}

			if (hadKey && previous !== resolved) {
				if (isObjectLike(previous)) detach(handle, previous);

				if (incoming === undefined) membership.keys.delete(key);
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

			if (key !== "length" && Array.isArray(target) && previousLength !== target.length) {
				recordOperation(handle, target, {
					node,
					key: "length",
					meta,
					before: previousLength,
					after: target.length,
					hasBefore: true,
					hasAfter: true,
				});
			}
		}

		return result;
	},

	deleteProperty(target, key) {
		if (typeof key !== "string" || isRideAlongKey(target, key)) return Reflect.deleteProperty(target, key);

		const { hadPrevious, previous } = ownDataDescriptor(target, key);
		const result = Reflect.deleteProperty(target, key);

		if (!result || !hadPrevious) return result;

		const meta = currentMeta();
		const node = proxyOf(target);

		for (const [handle, membership] of membershipsOf(target)) {
			if (membership.keys.delete(key) && isObjectLike(previous)) detach(handle, previous);

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
		for (const [handle] of membershipsOf(target)) evict(handle, target);

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
