import { getUntracked } from "proxy-compare";
import { proxy, unstable_getInternalStates, unstable_replaceInternalFunction } from "valtio/vanilla";
import { commitBatchWrite, currentBatchFrame, prepareBatchWrite } from "../batch";
import { addInEdge, edgeStatusOf, removeInEdge, seedInEdgesUnder } from "../edges";
import { handlesOf, type Handle } from "../handle";
import { getRegisteredTarget } from "../identity";
import { isIgnored } from "../ignore";
import { isPlainArray } from "../ops/cloneValue";
import { isCanonicalArrayIndexString } from "../ops/predicates";
import { peelReadProxy } from "../peelReadProxy";
import { isUnsafeMarked } from "../unsafeTrack";
import { walkDataEntries } from "../utils/dataEntries";
import { nonWritablePropertyError, rejectionError, snapshotDonationError } from "./boundaryErrors";
import { admissionDecision, admissionLane, classifyValue, type AdmissionLane } from "./classify";
import { createSnapshotPreservingAccessors } from "./snapshotAccessors";

const { proxyStateMap, proxyCache } = unstable_getInternalStates();

const rawTargetOf = (value: object): object => proxyStateMap.get(value)?.[0] ?? value;

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

interface SetFrame {
	readonly target: object;
	readonly prop: string | symbol;
}

const setFrameStack = new Array<SetFrame>();

const currentSetParentOf = (): object | undefined => setFrameStack[setFrameStack.length - 1]?.target;

const isMarkable = (value: unknown): value is object =>
	(typeof value === "object" && value !== null) || typeof value === "function";

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
	value: object,
	path: Array<string>,
	visits: Set<object>,
	mode: DataPathWalkMode,
	ignored: boolean,
	unsafe: boolean,
): void => {
	const node = mode === "admission" ? rawTargetOf(value) : value;

	if (visits.has(node)) return;

	visits.add(node);

	if (ignored) return;

	for (const entry of walkDataEntries(node)) {
		const childPath = [...path, entry.key];
		const child: unknown = entry.value;
		const childIgnored = isMarkable(child) && isIgnored(child);
		const childUnsafe = unsafe || (isMarkable(child) && isUnsafeMarked(child));

		if (mode === "admission" && classifyValue(node) === "cleanClass" && !unsafe && typeof child === "function")
			throw rejectionError(node, "cleanClass", childPath);

		if (typeof child !== "object" || child === null) continue;

		if (!entry.writable) {
			if (mode === "admission" && !childIgnored && !childUnsafe && admissionLane(child) !== "untracked")
				throw nonWritablePropertyError(child, childPath);

			continue;
		}

		if (childIgnored) continue;

		let childNode: object = child;

		if (proxyStateMap.has(childNode)) {
			if (mode !== "admission") continue;

			childNode = rawTargetOf(childNode);
		}

		if (mode === "admission") {
			if (childUnsafe) {
				walkDataPaths(childNode, childPath, visits, mode, childIgnored, childUnsafe);

				continue;
			}

			if (certifyAdmission(childNode, childPath, childUnsafe) === "tracked")
				walkDataPaths(childNode, childPath, visits, mode, childIgnored, childUnsafe);

			continue;
		}

		if (admissionLane(childNode) === "untracked") continue;

		walkDataPaths(childNode, childPath, visits, mode, childIgnored, childUnsafe);
	}
};

export const assertSafeDataPaths = (
	value: object,
	path: Array<string>,
	visits: Set<object>,
	mode: DataPathWalkMode = "admission",
	unsafe = false,
): void => {
	walkDataPaths(value, path, visits, mode, isIgnored(value), unsafe || isUnsafeMarked(value));
};

const certifyCurrentAssignment = (target: object, prop: string | symbol, resolved: object): void => {
	if (typeof prop !== "string") return;

	const path = [prop];

	for (const handle of handlesOf(target)) {
		if (!handle.strict) continue;

		if (!edgeStatusOf(handle, target).occupied) continue;

		const ignored = isIgnored(resolved);
		const unsafe = handle.nodes.get(rawTargetOf(target))?.exempt === true || isUnsafeMarked(resolved);

		if (ignored || unsafe) continue;

		if (typeof resolved === "function") {
			const parentKind = classifyValue(rawTargetOf(target));

			if (parentKind !== "plain" && parentKind !== "plainArray")
				throw rejectionError(rawTargetOf(target), parentKind, path);

			continue;
		}

		const decision = admissionDecision(resolved);

		if (decision.lane === "dangerous") throw rejectionError(resolved, decision.kind, path);

		if (decision.lane === "tracked") walkDataPaths(resolved, path, new Set(), "admission", ignored, unsafe);
	}
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
		(!rootHandle.strict || isUnsafeMarked(value) || rootHandle.nodes.get(rawTargetOf(value))?.exempt === true)
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
	if (isMarkable(value) && isIgnored(value)) return false;

	const parent = currentSetParentOf();
	const handles =
		parent === undefined ? [] : handlesOf(parent).filter((handle) => edgeStatusOf(handle, parent).occupied);

	if (handles.length === 0) return canProxy(value, parent);

	const unsafe = handles.every((handle) => {
		if (!handle.strict) return true;

		if (isMarkable(value) && isUnsafeMarked(value)) return true;

		if (parent === undefined) return false;

		return handle.nodes.get(rawTargetOf(parent))?.exempt === true;
	});

	return canProxy(value, parent, unsafe);
};

const truncatedOccupantsOf = (
	target: object,
	prop: string | symbol,
	next: unknown,
): Array<{ index: number; occupant: object }> | undefined => {
	if (!Array.isArray(target) || prop !== "length") return undefined;

	const coercible = next === null || (typeof next !== "object" && typeof next !== "function");
	const newLength = coercible ? Number(next) : Number.NaN;

	if (!Number.isInteger(newLength) || newLength < 0 || newLength >= target.length) return undefined;

	const truncated = new Array<{ index: number; occupant: object }>();

	for (let index = newLength; index < target.length; index++) {
		const occupant: unknown = Reflect.get(target, index);

		if (typeof occupant === "object" && occupant !== null) truncated.push({ index, occupant });
	}

	return truncated;
};

const commitSetInEdges = (
	target: object,
	prop: string | symbol,
	previous: unknown,
	next: unknown,
	truncated: Array<{ index: number; occupant: object }> | undefined,
): void => {
	const handles = handlesOf(target);

	if (handles.length === 0) return;

	if (truncated !== undefined) {
		for (const { index, occupant } of truncated) {
			for (const handle of handles) removeInEdge(handle, occupant, target, index);
		}

		return;
	}

	if (typeof prop !== "string") return;

	const key = segmentForProp(target, prop);
	const previousObject = typeof previous === "object" && previous !== null ? previous : undefined;
	const nextObject =
		typeof next === "object" && next !== null && admissionLane(next) !== "untracked" ? next : undefined;

	for (const handle of handles) {
		if (nextObject !== undefined && isIgnored(nextObject)) {
			if (previousObject !== undefined) removeInEdge(handle, previousObject, target, key);

			continue;
		}

		if (previousObject !== undefined) removeInEdge(handle, previousObject, target, key);

		if (nextObject === undefined) continue;

		const rawNext = rawTargetOf(nextObject);
		const wasOccupied =
			rawNext === rawTargetOf(handle.proxy.root) || (handle.nodes.get(rawNext)?.edges.length ?? 0) > 0;

		addInEdge(handle, nextObject, target, key);

		if (wasOccupied) continue;

		seedInEdgesUnder(handle, nextObject);
	}
};

const commitDeleteInEdges = (target: object, prop: string | symbol, previous: unknown): void => {
	if (typeof prop !== "string") return;

	if (typeof previous !== "object" || previous === null) return;

	const key = segmentForProp(target, prop);

	for (const handle of handlesOf(target)) removeInEdge(handle, previous, target, key);
};

interface BatchWriteSession {
	readonly handles: ReadonlyArray<Handle>;
	readonly restorers: ReadonlyArray<() => void>;
	claimed: boolean;
}

const beginBatchWrites = (target: object, initializing: boolean): BatchWriteSession | undefined => {
	if (initializing || currentBatchFrame() === undefined) return undefined;

	const handles = handlesOf(target);
	const restorers: Array<() => void> = [];

	for (const handle of handles) {
		const restore = prepareBatchWrite(handle);

		if (restore !== undefined) restorers.push(restore);
	}

	return { handles, restorers, claimed: false };
};

const succeedBatchWrites = (session: BatchWriteSession | undefined): void => {
	if (session === undefined) return;

	for (const handle of session.handles) commitBatchWrite(handle);

	session.claimed = true;
};

const abandonBatchWrites = (session: BatchWriteSession | undefined): void => {
	if (session === undefined || session.claimed) return;

	for (const restore of session.restorers) restore();
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
					const truncated = truncatedOccupantsOf(target, prop, resolved);
					const previous: unknown = typeof prop === "string" ? Reflect.get(target, prop) : undefined;
					const initializing = isInitializing();
					const session = beginBatchWrites(target, initializing);

					setFrameStack.push({ target, prop });

					try {
						if (typeof resolved === "object" && resolved !== null) {
							if (getRegisteredTarget(resolved) !== undefined) throw snapshotDonationError(prop);

							if (refusesWrite(target, prop, resolved)) return false;

							if (!initializing && !writesThroughAccessor(target, prop))
								certifyCurrentAssignment(target, prop, resolved);

							const alreadyTracked = proxyStateMap.has(resolved) || proxyCache.has(resolved);
							const instrumented =
								!alreadyTracked && canProxyCurrentAssignment(resolved) ? proxy(resolved) : resolved;

							const result = defaultSet(target, prop, instrumented, receiver);

							if (result && !initializing) {
								commitSetInEdges(target, prop, previous, instrumented, truncated);
								succeedBatchWrites(session);
							}

							return result;
						}

						if (refusesWrite(target, prop, resolved)) return false;

						if (!initializing && typeof resolved === "function" && !writesThroughAccessor(target, prop))
							certifyCurrentAssignment(target, prop, resolved);

						const result = defaultSet(target, prop, resolved, receiver);

						if (result && !initializing) {
							commitSetInEdges(target, prop, previous, resolved, truncated);
							succeedBatchWrites(session);
						}

						return result;
					} finally {
						abandonBatchWrites(session);
						setFrameStack.pop();
					}
				},
				deleteProperty(target, prop) {
					const initializing = isInitializing();
					const session = beginBatchWrites(target, initializing);
					const previous: unknown = typeof prop === "string" ? Reflect.get(target, prop) : undefined;

					try {
						const result = defaultDelete(target, prop);

						if (result && !initializing) {
							commitDeleteInEdges(target, prop, previous);
							succeedBatchWrites(session);
						}

						return result;
					} finally {
						abandonBatchWrites(session);
					}
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
