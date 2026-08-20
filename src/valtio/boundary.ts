import { getUntracked } from "proxy-compare";
import { proxy, unstable_getInternalStates, unstable_replaceInternalFunction } from "valtio/vanilla";
import { handlesOf, type Handle } from "../handle";
import { getRegisteredTarget } from "../identity";
import { isUnderIgnoredOccupancy, isUnderUnsafeOccupancy } from "../occupancy";
import { isPlainArray } from "../ops/cloneValue";
import { appendOperationPath, createOperationPath, type OperationPath } from "../ops/path";
import { isCanonicalArrayIndexString } from "../ops/predicates";
import { peelReadProxy } from "../peelReadProxy";
import { walkDataEntries } from "../utils/dataEntries";
import { nonWritablePropertyError, rejectionError, snapshotDonationError } from "./boundaryErrors";
import { admissionDecision, admissionLane, classifyValue, type AdmissionLane } from "./classify";
import { createSnapshotPreservingAccessors } from "./snapshotAccessors";

const { proxyStateMap, proxyCache } = unstable_getInternalStates();

const rawTargetOf = (value: object): object => proxyStateMap.get(value)?.[0] ?? value;

interface SetFrame {
	readonly target: object;
	readonly prop: string | symbol;
}

const setFrameStack = new Array<SetFrame>();

const currentSetParentOf = (): object | undefined => setFrameStack[setFrameStack.length - 1]?.target;

const dataPathKey = (path: ReadonlyArray<string>): string => (path.length === 0 ? "/" : `/${path.join("/")}`);

const handleOwning = (target: object): Handle | undefined => {
	const handles = handlesOf(target);
	const raw = rawTargetOf(target);

	for (const handle of handles) {
		if (rawTargetOf(handle.proxy.root) === raw) return handle;
	}

	return handles[0];
};

const segmentForProp = (parent: object, prop: string): string | number =>
	isPlainArray(parent) && isCanonicalArrayIndexString(prop) ? Number(prop) : prop;

const pathOfCurrentAssignment = (): { handle: Handle; path: OperationPath } | undefined => {
	const current = setFrameStack[setFrameStack.length - 1];

	if (current === undefined || typeof current.prop !== "string") return undefined;

	const currentRaw = rawTargetOf(current.target);

	for (const handle of handlesOf(current.target)) {
		const routes = handle.routes.get(currentRaw);

		if (routes !== undefined && routes.length > 0) {
			const route = routes[0];

			if (route === undefined) continue;

			return { handle, path: appendOperationPath(route, segmentForProp(current.target, current.prop)) };
		}

		if (rawTargetOf(handle.proxy.root) === currentRaw) {
			return { handle, path: createOperationPath([segmentForProp(current.target, current.prop)]) };
		}
	}

	let owner: Handle | undefined;
	let ownerIndex = 0;

	for (let index = 0; index < setFrameStack.length; index++) {
		const frame = setFrameStack[index];

		if (frame === undefined) continue;

		const found = handleOwning(frame.target);

		if (found !== undefined) {
			owner = found;
			ownerIndex = index;
		}
	}

	if (owner === undefined) return undefined;

	const segments = new Array<string | number>();

	for (let index = ownerIndex; index < setFrameStack.length; index++) {
		const frame = setFrameStack[index];

		if (frame === undefined || typeof frame.prop !== "string") return undefined;

		segments.push(segmentForProp(frame.target, frame.prop));
	}

	return { handle: owner, path: createOperationPath(segments) };
};

const certifyAdmission = (value: object, path?: ReadonlyArray<string>, unsafe = false): AdmissionLane => {
	const decision = admissionDecision(value);

	if (decision.lane === "dangerous" && !unsafe) throw rejectionError(value, decision.kind, path);

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

const walkDataPaths = (
	value: unknown,
	path: Array<string>,
	visits: Set<object>,
	mode: DataPathWalkMode,
	ignoredAt: ReadonlySet<string>,
	unsafeAt: ReadonlySet<string>,
	ignored: boolean,
	unsafe: boolean,
): void => {
	if (typeof value !== "object" || value === null) return;

	if (visits.has(value)) return;

	visits.add(value);

	if (ignored) return;

	for (const entry of walkDataEntries(value)) {
		const childPath = [...path, entry.key];
		const childKey = dataPathKey(childPath);
		const childIgnored = ignoredAt.has(childKey);
		const childUnsafe = unsafe || unsafeAt.has(childKey);
		const child: unknown = entry.value;

		if (mode === "admission" && classifyValue(value) === "cleanClass" && !unsafe && typeof child === "function")
			throw rejectionError(value, "cleanClass", childPath);

		if (typeof child !== "object" || child === null) continue;

		if (!entry.writable) {
			if (mode === "admission" && !childIgnored && !childUnsafe && admissionLane(child) !== "untracked")
				throw nonWritablePropertyError(child, childPath);

			continue;
		}

		if (childIgnored) continue;

		if (proxyStateMap.has(child)) continue;

		if (mode === "admission") {
			if (childUnsafe) {
				walkDataPaths(child, childPath, visits, mode, ignoredAt, unsafeAt, childIgnored, childUnsafe);

				continue;
			}

			if (certifyAdmission(child, childPath, childUnsafe) === "tracked")
				walkDataPaths(child, childPath, visits, mode, ignoredAt, unsafeAt, childIgnored, childUnsafe);

			continue;
		}

		if (admissionLane(child) === "untracked") continue;

		walkDataPaths(child, childPath, visits, mode, ignoredAt, unsafeAt, childIgnored, childUnsafe);
	}
};

export const assertSafeDataPaths = (
	value: unknown,
	path: Array<string>,
	visits: Set<object>,
	mode: DataPathWalkMode = "admission",
	ignoredAt: ReadonlySet<string> = new Set(),
	unsafeAt: ReadonlySet<string> = new Set(),
): void => {
	walkDataPaths(
		value,
		path,
		visits,
		mode,
		ignoredAt,
		unsafeAt,
		ignoredAt.has(dataPathKey(path)),
		unsafeAt.has(dataPathKey(path)),
	);
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

export function canProxy(value: unknown, parentTarget?: object, unsafe = false): boolean {
	if (typeof value !== "object" || value === null) return false;

	if (admissionLane(value) === "tracked") return true;

	if (unsafe) return true;

	if (proxyStateMap.has(value)) return true;

	const rootHandle = handleOwning(value);

	if (
		rootHandle !== undefined &&
		rawTargetOf(rootHandle.proxy.root) === rawTargetOf(value) &&
		(!rootHandle.strict || rootHandle.unsafeAt.has("/"))
	)
		return true;

	if (parentTarget === undefined) return false;

	const handles = handlesOf(parentTarget);

	return handles.length === 1 && handles[0]?.strict === false && admissionLane(value) === "dangerous";
}

class MissingMutationTrapError extends Error {
	constructor() {
		super("opshot: valtio default handler is missing a mutation trap");
		this.name = "MissingMutationTrapError";
	}
}

const canProxyCurrentAssignment = (value: unknown): boolean => {
	const assignment = pathOfCurrentAssignment();

	if (assignment !== undefined) {
		if (isUnderIgnoredOccupancy(assignment.handle, assignment.path)) return false;

		return canProxy(value, currentSetParentOf(), isUnderUnsafeOccupancy(assignment.handle, assignment.path));
	}

	return canProxy(value, currentSetParentOf());
};

let installed = false;

export function installBoundary(): void {
	if (installed) return;

	installed = true;

	unstable_replaceInternalFunction("canProxy", () => (value) => canProxyCurrentAssignment(value));

	unstable_replaceInternalFunction("createSnapshot", () => createSnapshotPreservingAccessors);

	unstable_replaceInternalFunction(
		"createHandler",
		(createHandler) => (isInitializing, addPropListener, removePropListener, notifyUpdate) => {
			const handler = createHandler(isInitializing, addPropListener, removePropListener, notifyUpdate);
			const defaultDelete = handler.deleteProperty;
			const defaultSet = handler.set;

			if (!defaultDelete || !defaultSet) throw new MissingMutationTrapError();

			return {
				...handler,
				set(target, prop, value, receiver) {
					const assigned: unknown = value;

					const resolved: unknown = peelSnapshotsAndReadProxies(assigned);

					setFrameStack.push({ target, prop });

					try {
						if (typeof resolved === "object" && resolved !== null) {
							if (getRegisteredTarget(resolved) !== undefined) throw snapshotDonationError(prop);

							if (refusesWrite(target, prop, resolved)) return false;

							const alreadyTracked = proxyStateMap.has(resolved) || proxyCache.has(resolved);
							const instrumented =
								!alreadyTracked && canProxyCurrentAssignment(resolved) ? proxy(resolved) : resolved;

							return defaultSet(target, prop, instrumented, receiver);
						}

						if (refusesWrite(target, prop, resolved)) return false;

						return defaultSet(target, prop, resolved, receiver);
					} finally {
						setFrameStack.pop();
					}
				},
				deleteProperty(target, prop) {
					return defaultDelete(target, prop);
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
