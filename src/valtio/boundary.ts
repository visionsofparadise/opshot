import { getUntracked } from "proxy-compare";
import { proxy, unstable_getInternalStates, unstable_replaceInternalFunction } from "valtio/vanilla";
import { handlesOf } from "../handle";
import { getRegisteredTarget } from "../identity";
import { pendingIgnore } from "../ignore";
import { discardPendingOccupancy, recordPendingOccupancy } from "../occupancy";
import { flagPossiblyShared } from "../ops/commitWalk";
import { peelReadProxy } from "../peelReadProxy";
import { pendingUnsafe } from "../unsafeTrack";
import { walkDataEntries } from "../utils/dataEntries";
import { nonWritablePropertyError, rejectionError, snapshotDonationError } from "./boundaryErrors";
import { admissionDecision, admissionLane, classifyValue, type AdmissionLane } from "./classify";
import { createSnapshotPreservingAccessors } from "./snapshotAccessors";

const { proxyStateMap, proxyCache, refSet } = unstable_getInternalStates();

const rawTargetOf = (value: object): object => proxyStateMap.get(value)?.[0] ?? value;

const setTargetStack = new Array<object>();

const currentSetParentOf = (): object | undefined => setTargetStack[setTargetStack.length - 1];

const certifyAdmission = (value: object, path?: ReadonlyArray<string>): AdmissionLane => {
	if (pendingIgnore.has(value) || pendingUnsafe.has(value)) return admissionDecision(value).lane;

	const decision = admissionDecision(value);

	if (decision.lane === "dangerous") throw rejectionError(value, decision.kind, path);

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

export type DataPathWalkMode = "admission" | "rootsOnly";

const walkDataPaths = (value: unknown, path: Array<string>, visits: Set<object>, mode: DataPathWalkMode): void => {
	if (typeof value !== "object" || value === null) return;

	if (visits.has(value)) return;

	visits.add(value);

	if (refSet.has(value) || pendingIgnore.has(value)) return;

	for (const entry of walkDataEntries(value)) {
		const child: unknown = entry.value;

		if (
			mode === "admission" &&
			classifyValue(value) === "cleanClass" &&
			!pendingUnsafe.has(value) &&
			typeof child === "function"
		)
			throw rejectionError(value, "cleanClass", [...path, entry.key]);

		if (typeof child !== "object" || child === null) continue;

		const childPath = [...path, entry.key];

		if (!entry.writable) {
			if (mode === "admission" && !pendingIgnore.has(child) && admissionLane(child) !== "untracked")
				throw nonWritablePropertyError(child, childPath);

			continue;
		}

		if (refSet.has(child) || pendingIgnore.has(child)) continue;

		if (proxyStateMap.has(child)) {
			continue;
		}

		if (mode === "admission") {
			if (pendingUnsafe.has(child)) {
				walkDataPaths(child, childPath, visits, mode);

				continue;
			}

			if (certifyAdmission(child, childPath) === "tracked") walkDataPaths(child, childPath, visits, mode);

			continue;
		}

		if (admissionLane(child) === "untracked") continue;

		walkDataPaths(child, childPath, visits, mode);
	}
};

export const assertSafeDataPaths = (
	value: unknown,
	path: Array<string>,
	visits: Set<object>,
	mode: DataPathWalkMode = "admission",
): void => {
	walkDataPaths(value, path, visits, mode);
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

export function canProxy(value: unknown, parentTarget?: object): boolean {
	if (typeof value !== "object" || value === null) return false;

	if (pendingIgnore.has(value)) return false;

	if (admissionLane(value) === "tracked") return true;

	if (pendingUnsafe.has(value)) return true;

	if (proxyStateMap.has(value)) return true;

	if (parentTarget === undefined) return false;

	const handles = handlesOf(parentTarget);

	return handles.length === 1 && handles[0]?.strict === false && admissionLane(value) === "dangerous";
}

let installed = false;

export function installBoundary(): void {
	if (installed) return;

	installed = true;

	unstable_replaceInternalFunction("canProxy", () => (value) => canProxy(value, currentSetParentOf()));

	unstable_replaceInternalFunction("createSnapshot", () => createSnapshotPreservingAccessors);

	unstable_replaceInternalFunction(
		"createHandler",
		(createHandler) => (isInitializing, addPropListener, removePropListener, notifyUpdate) => {
			const handler = createHandler(isInitializing, addPropListener, removePropListener, notifyUpdate);
			const defaultDelete = handler.deleteProperty;
			const defaultSet = handler.set;

			if (!defaultDelete || !defaultSet)
				throw new Error("opshot: valtio default handler is missing a mutation trap");

			return {
				...handler,
				set(target, prop, value, receiver) {
					const assigned: unknown = value;

					const resolved: unknown = peelSnapshotsAndReadProxies(assigned);

					const previous: unknown = Reflect.get(target, prop, receiver);

					setTargetStack.push(target);

					try {
						if (typeof resolved === "object" && resolved !== null) {
							if (getRegisteredTarget(resolved) !== undefined) throw snapshotDonationError(prop);

							const ignoreWrap = pendingIgnore.has(resolved);
							const unsafeWrap = !ignoreWrap && pendingUnsafe.has(resolved);
							const alreadyTracked = proxyStateMap.has(resolved) || proxyCache.has(resolved);

							if (refusesWrite(target, prop, resolved)) return false;

							const instrumented = !alreadyTracked && canProxy(resolved, target) ? proxy(resolved) : resolved;

							const result = defaultSet(target, prop, instrumented, receiver);

							if (result) discardPendingOccupancy(target, prop);

							if (ignoreWrap || unsafeWrap) {
								const stored: unknown = Reflect.get(target, prop);

								if (result && typeof stored === "object" && stored !== null) {
									recordPendingOccupancy(target, prop, rawTargetOf(stored), ignoreWrap ? "ignore" : "unsafe");
								}

								if (ignoreWrap) pendingIgnore.delete(resolved);

								if (unsafeWrap) pendingUnsafe.delete(resolved);

								if (Object.is(previous, stored) || Object.is(previous, resolved)) {
									notifyUpdate(["set", [prop], resolved, previous]);
								}
							}

							if (!refSet.has(resolved) && alreadyTracked) {
								flagPossiblyShared(resolved);
							}

							return result;
						}

						if (refusesWrite(target, prop, resolved)) return false;

						const result = defaultSet(target, prop, resolved, receiver);

						if (result) discardPendingOccupancy(target, prop);

						return result;
					} finally {
						setTargetStack.pop();
					}
				},
				deleteProperty(target, prop) {
					const result = defaultDelete(target, prop);

					if (result) discardPendingOccupancy(target, prop);

					return result;
				},
				defineProperty(target, prop, descriptor) {
					return Reflect.defineProperty(target, prop, descriptor);
				},
				setPrototypeOf(target, proto) {
					return Reflect.setPrototypeOf(target, proto);
				},
				preventExtensions(target) {
					return Reflect.preventExtensions(target);
				},
			};
		},
	);
}
