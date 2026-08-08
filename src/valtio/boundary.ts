import { getUntracked } from "proxy-compare";
import { unstable_getInternalStates, unstable_replaceInternalFunction } from "valtio/vanilla";
import { getRegisteredTarget } from "../identity";
import { peelReadProxy } from "../react/peelReadProxy";
import { getOptions, inheritOptions } from "../settings";
import { unsafeTrack } from "../unsafeTrack";
import { walkDataEntries } from "../utils/dataEntries";
import {
	definePropertyError,
	nonWritablePropertyError,
	ownProtoKeyError,
	preventExtensionsError,
	rejectionError,
	setPrototypeOfError,
	snapshotDonationError,
} from "./boundaryErrors";
import { admissionDecision, admissionLane, type AdmissionLane } from "./classify";
import { createSnapshotPreservingAccessors } from "./snapshotAccessors";

const { proxyStateMap } = unstable_getInternalStates();

const certifyAdmission = (value: object, path?: ReadonlyArray<string>): AdmissionLane => {
	const decision = admissionDecision(value);

	if (decision.lane === "reject") throw rejectionError(value, decision.kind, path);

	return decision.lane;
};

const peelSnapshotsAndReadProxies = (value: unknown): unknown => {
	let current: unknown = value;

	while (typeof current === "object" && current !== null) {
		const untracked: unknown = getUntracked(current);
		const next: unknown = peelReadProxy(untracked ?? current);

		if (next === current) break;

		current = next;
	}

	return current;
};

const walkDataPaths = (value: unknown, path: Array<string>, visits: Set<object>): void => {
	if (typeof value !== "object" || value === null) return;

	if (visits.has(value)) return;

	visits.add(value);

	for (const entry of walkDataEntries(value)) {
		const child: unknown = entry.value;

		if (typeof child !== "object" || child === null) continue;

		const childPath = [...path, entry.key];

		if (!entry.writable) {
			if (admissionLane(child) === "leaf") continue;

			throw nonWritablePropertyError(child, childPath);
		}

		if (!proxyStateMap.has(child) && certifyAdmission(child, childPath) === "track")
			walkDataPaths(child, childPath, visits);
	}
};

export const assertSafeDataPaths = (value: unknown, path: Array<string>, visits: Set<object>): void => {
	walkDataPaths(value, path, visits);
};

const refusesWrite = (target: object, property: string | symbol, value: unknown): boolean => {
	if (Array.isArray(target)) {
		if (property === "length") {
			const coercible = value === null || (typeof value !== "object" && typeof value !== "function");
			const newLength = coercible ? Number(value) : Number.NaN;

			if (Number.isInteger(newLength) && newLength >= 0 && newLength < target.length) {
				for (const key of Reflect.ownKeys(target)) {
					if (typeof key !== "string") continue;

					const index = Number(key);

					if (
						Number.isInteger(index) &&
						index >= newLength &&
						index < 2 ** 32 - 1 &&
						String(index) === key &&
						Reflect.getOwnPropertyDescriptor(target, key)?.configurable !== true
					)
						return true;
				}
			}
		} else if (typeof property === "string") {
			const index = Number(property);

			if (
				Number.isInteger(index) &&
				index >= 0 &&
				index < 2 ** 32 - 1 &&
				String(index) === property &&
				index >= target.length &&
				Reflect.getOwnPropertyDescriptor(target, "length")?.writable === false
			)
				return true;
		}
	}

	let holder: object | null = target;

	while (holder !== null) {
		const descriptor = Reflect.getOwnPropertyDescriptor(holder, property);

		if (descriptor !== undefined) {
			if ("value" in descriptor) {
				if (descriptor.writable !== true) return true;

				return holder !== target && !Object.isExtensible(target);
			}

			return descriptor.set === undefined;
		}

		holder = Reflect.getPrototypeOf(holder);
	}

	return !Object.isExtensible(target);
};

let installed = false;

export function installBoundary(): void {
	if (installed) return;

	installed = true;

	unstable_replaceInternalFunction("canProxy", () => (value) => {
		if (typeof value !== "object" || value === null) return false;

		return certifyAdmission(value) === "track";
	});

	unstable_replaceInternalFunction("createSnapshot", () => createSnapshotPreservingAccessors);

	unstable_replaceInternalFunction(
		"createHandler",
		(createHandler) => (isInitializing, addPropListener, removePropListener, notifyUpdate) => {
			let setDepth = 0;

			const handler = createHandler(isInitializing, addPropListener, removePropListener, notifyUpdate);
			const defaultDelete = handler.deleteProperty;
			const defaultSet = handler.set;

			if (!defaultDelete || !defaultSet)
				throw new Error("opshot: valtio default handler is missing a mutation trap");

			return {
				...handler,
				set(target, prop, value, receiver) {
					const assigned: unknown = value;

					if (prop === "__proto__") throw ownProtoKeyError();

					const resolved: unknown = peelSnapshotsAndReadProxies(assigned);

					const location = typeof prop === "string" ? [prop] : [];
					const strict = getOptions(target)?.strict !== false;

					if (typeof resolved === "object" && resolved !== null) {
						const decision = admissionDecision(resolved);

						if (strict && !isInitializing() && decision.lane === "track")
							assertSafeDataPaths(resolved, location, new Set());

						if (getRegisteredTarget(resolved) !== undefined) throw snapshotDonationError(prop);

						inheritOptions(target, resolved);

						if (!proxyStateMap.has(resolved) && decision.lane === "reject") {
							if (getOptions(target)?.strict === false) unsafeTrack(resolved);
							else throw rejectionError(resolved, decision.kind, isInitializing() ? undefined : location);
						}
					}

					if (refusesWrite(target, prop, resolved)) return false;

					setDepth += 1;

					try {
						return defaultSet(target, prop, resolved, receiver);
					} finally {
						setDepth -= 1;
					}
				},
				defineProperty(target, prop, descriptor) {
					if (setDepth > 0 || isInitializing()) return Reflect.defineProperty(target, prop, descriptor);

					throw definePropertyError();
				},
				setPrototypeOf() {
					throw setPrototypeOfError();
				},
				preventExtensions() {
					throw preventExtensionsError();
				},
			};
		},
	);
}
