import { getUntracked } from "proxy-compare";
import { unstable_getInternalStates, unstable_replaceInternalFunction } from "valtio/vanilla";
import { getRegisteredTarget } from "../identity";
import { liveRootsOf, registerInEdge, unregisterInEdge } from "../inEdges";
import { peelReadProxy } from "../peelReadProxy";
import { getOptions, inheritOptions, restampOptions, type MutableNodeOptions } from "../settings";
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
	strictnessJoinError,
} from "./boundaryErrors";
import { admissionDecision, admissionLane, type AdmissionLane } from "./classify";
import { createSnapshotPreservingAccessors } from "./snapshotAccessors";

const { proxyStateMap } = unstable_getInternalStates();

const rawTargetOf = (value: object): object => proxyStateMap.get(value)?.[0] ?? value;

const ownDataValue = (target: object, property: string | symbol): unknown => {
	const descriptor = Reflect.getOwnPropertyDescriptor(target, property);

	if (descriptor === undefined || !("value" in descriptor)) return undefined;

	return descriptor.value;
};

const isTrackedProxy = (value: unknown): value is object =>
	typeof value === "object" && value !== null && proxyStateMap.has(value);

const maintainInEdgeOnSet = (
	target: object,
	property: string | symbol,
	previous: unknown,
	truncatedFrom?: number,
	truncatedValues: ReadonlyArray<unknown> = [],
): void => {
	if (typeof property !== "string") return;

	if (isTrackedProxy(previous)) unregisterInEdge(rawTargetOf(previous), target, property);

	if (truncatedFrom !== undefined) {
		for (let offset = 0; offset < truncatedValues.length; offset += 1) {
			const removed = truncatedValues[offset];

			if (isTrackedProxy(removed)) unregisterInEdge(rawTargetOf(removed), target, String(truncatedFrom + offset));
		}
	}

	const next = ownDataValue(target, property);

	if (isTrackedProxy(next)) registerInEdge(rawTargetOf(next), target, property);
};

const arrayLengthTruncation = (
	target: object,
	previousLength: unknown,
	nextLength: unknown,
): { from: number; values: Array<unknown> } | undefined => {
	if (!Array.isArray(target) || typeof previousLength !== "number" || typeof nextLength !== "number") return undefined;

	const end = Math.min(Math.trunc(previousLength), 2 ** 32 - 1);
	const from = Math.min(Math.max(0, Math.trunc(nextLength)), end);

	if (from >= end) return undefined;

	const values: Array<unknown> = [];

	for (let index = from; index < end; index += 1) values.push(ownDataValue(target, String(index)));

	return { from, values };
};

const maintainInEdgeOnDelete = (target: object, property: string | symbol, previous: unknown): void => {
	if (typeof property !== "string") return;

	if (isTrackedProxy(previous)) unregisterInEdge(rawTargetOf(previous), target, property);
};

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

const effectiveStrictOf = (target: object): boolean => getOptions(target)?.strict !== false;

const proxiedChildTargetsOf = (nodeTarget: object): Array<object> => {
	const children = new Array<object>();

	for (const entry of walkDataEntries(nodeTarget)) {
		const child: unknown = entry.value;

		if (typeof child === "object" && child !== null && proxyStateMap.has(child)) children.push(rawTargetOf(child));
	}

	return children;
};

const assertStrictnessJoinOrRestamp = (
	resolved: object,
	receiverStrict: boolean,
	receiverOptions: MutableNodeOptions | undefined,
	key: string | symbol,
): void => {
	const incomingTarget = rawTargetOf(resolved);
	const visits = new Set<object>();
	const queue = [incomingTarget];
	let hasLiveRoot = false;

	while (queue.length > 0) {
		const nodeTarget = queue.pop();

		if (nodeTarget === undefined || visits.has(nodeTarget)) continue;

		visits.add(nodeTarget);

		for (const root of liveRootsOf(nodeTarget)) {
			hasLiveRoot = true;

			if (effectiveStrictOf(root) !== receiverStrict) throw strictnessJoinError(key);
		}

		for (const childTarget of proxiedChildTargetsOf(nodeTarget)) queue.push(childTarget);
	}

	if (hasLiveRoot) return;

	for (const nodeTarget of visits) restampOptions(nodeTarget, receiverOptions);
};

export const assertInitializerStrictnessJoins = (
	value: unknown,
	receiverStrict: boolean,
	receiverOptions: MutableNodeOptions | undefined,
): void => {
	const visits = new Set<object>();

	const walk = (current: unknown, path: Array<string>): void => {
		if (typeof current !== "object" || current === null) return;

		if (visits.has(current)) return;

		visits.add(current);

		if (proxyStateMap.has(current)) {
			assertStrictnessJoinOrRestamp(current, receiverStrict, receiverOptions, path[path.length - 1] ?? "");

			return;
		}

		for (const entry of walkDataEntries(current)) {
			walk(entry.value, [...path, entry.key]);
		}
	};

	walk(value, []);
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
					const receiverOptions = getOptions(target);
					const strict = receiverOptions?.strict !== false;

					if (typeof resolved === "object" && resolved !== null) {
						if (proxyStateMap.has(resolved)) {
							assertStrictnessJoinOrRestamp(resolved, strict, receiverOptions, prop);
						} else {
							const decision = admissionDecision(resolved);

							if (strict && !isInitializing() && decision.lane === "track")
								assertSafeDataPaths(resolved, location, new Set());

							if (getRegisteredTarget(resolved) !== undefined) throw snapshotDonationError(prop);

							inheritOptions(target, resolved);

							if (decision.lane === "reject") {
								if (receiverOptions?.strict === false) unsafeTrack(resolved);
								else throw rejectionError(resolved, decision.kind, isInitializing() ? undefined : location);
							}
						}
					}

					if (refusesWrite(target, prop, resolved)) return false;

					const previous = ownDataValue(target, prop);
					const truncation = prop === "length" ? arrayLengthTruncation(target, previous, resolved) : undefined;

					setDepth += 1;

					try {
						const succeeded = defaultSet(target, prop, resolved, receiver);

						if (succeeded) maintainInEdgeOnSet(target, prop, previous, truncation?.from, truncation?.values);

						return succeeded;
					} finally {
						setDepth -= 1;
					}
				},
				deleteProperty(target, prop) {
					const previous = ownDataValue(target, prop);
					const succeeded = defaultDelete(target, prop);

					if (succeeded) maintainInEdgeOnDelete(target, prop, previous);

					return succeeded;
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
