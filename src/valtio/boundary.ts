import { getUntracked } from "proxy-compare";
import { proxy, unstable_getInternalStates, unstable_replaceInternalFunction } from "valtio/vanilla";
import { declarationChild, type DeclarationTrie } from "../declarations";
import { addInEdge, descendChains, isIgnoredFrontier, removeInEdge, seedInEdgesUnder, slotStatusOf } from "../edges";
import { handlesOf, type Handle } from "../handle";
import { getRegisteredTarget } from "../identity";
import { isPlainArray } from "../ops/cloneValue";
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

interface AssignmentStatus {
	readonly handle: Handle;
	readonly ignored: boolean;
	readonly unsafe: boolean;
	readonly chains: ReadonlyArray<DeclarationTrie | undefined>;
	readonly originIndex: number;
}

let assignmentStatus: AssignmentStatus | undefined;

const computeOutermostAssignment = (
	target: object,
	prop: string | symbol,
	originIndex: number,
): AssignmentStatus | undefined => {
	if (typeof prop !== "string") return undefined;

	const handle = handleOwning(target);

	if (handle === undefined) return undefined;

	const slot = slotStatusOf(handle, target, segmentForProp(target, prop));

	return {
		handle,
		ignored: slot.ignored,
		unsafe: slot.unsafe,
		chains: slot.chains,
		originIndex,
	};
};

const statusOfCurrentAssignment = (): AssignmentStatus | undefined => {
	if (assignmentStatus === undefined) return undefined;

	if (setFrameStack.length <= assignmentStatus.originIndex + 1) return assignmentStatus;

	let chains = assignmentStatus.chains;
	let unsafe = assignmentStatus.unsafe;
	let ignored = assignmentStatus.ignored;

	for (let index = assignmentStatus.originIndex + 1; index < setFrameStack.length; index++) {
		const frame = setFrameStack[index];

		if (frame === undefined || typeof frame.prop !== "string") return assignmentStatus;

		const descended = descendChains(chains, segmentForProp(frame.target, frame.prop));

		ignored = ignored || descended.ignored;
		unsafe = unsafe || descended.unsafe;
		chains = descended.chains;
	}

	return {
		handle: assignmentStatus.handle,
		chains,
		unsafe,
		ignored,
		originIndex: assignmentStatus.originIndex,
	};
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
	value: object,
	path: Array<string>,
	visits: Set<object>,
	mode: DataPathWalkMode,
	residual: DeclarationTrie | undefined,
	ignored: boolean,
	unsafe: boolean,
): void => {
	if (visits.has(value)) return;

	visits.add(value);

	if (ignored) return;

	for (const entry of walkDataEntries(value)) {
		const childPath = [...path, entry.key];
		const childResidual = declarationChild(residual, entry.key);
		const childIgnored = childResidual?.ignored === true;
		const childUnsafe = unsafe || childResidual?.unsafe === true;
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
				walkDataPaths(child, childPath, visits, mode, childResidual, childIgnored, childUnsafe);

				continue;
			}

			if (certifyAdmission(child, childPath, childUnsafe) === "tracked")
				walkDataPaths(child, childPath, visits, mode, childResidual, childIgnored, childUnsafe);

			continue;
		}

		if (admissionLane(child) === "untracked") continue;

		walkDataPaths(child, childPath, visits, mode, childResidual, childIgnored, childUnsafe);
	}
};

export const assertSafeDataPaths = (
	value: object,
	path: Array<string>,
	visits: Set<object>,
	mode: DataPathWalkMode = "admission",
	declarations?: DeclarationTrie,
): void => {
	walkDataPaths(
		value,
		path,
		visits,
		mode,
		declarations,
		declarations?.ignored === true,
		declarations?.unsafe === true,
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
		(!rootHandle.strict || rootHandle.declarations?.unsafe === true)
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
	const assignment = statusOfCurrentAssignment();

	if (assignment === undefined) return canProxy(value, currentSetParentOf());

	if (assignment.ignored) return false;

	return canProxy(value, currentSetParentOf(), assignment.unsafe || !assignment.handle.strict);
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
		if (isIgnoredFrontier(handle, target, key)) {
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

		const slot = slotStatusOf(handle, target, key);

		seedInEdgesUnder(handle, nextObject, slot.chains);
	}
};

const commitDeleteInEdges = (target: object, prop: string | symbol, previous: unknown): void => {
	if (typeof prop !== "string") return;

	if (typeof previous !== "object" || previous === null) return;

	const key = segmentForProp(target, prop);

	for (const handle of handlesOf(target)) removeInEdge(handle, previous, target, key);
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
					const originIndex = setFrameStack.length;

					assignmentStatus ??= computeOutermostAssignment(target, prop, originIndex);

					setFrameStack.push({ target, prop });

					try {
						if (typeof resolved === "object" && resolved !== null) {
							if (getRegisteredTarget(resolved) !== undefined) throw snapshotDonationError(prop);

							if (refusesWrite(target, prop, resolved)) return false;

							const alreadyTracked = proxyStateMap.has(resolved) || proxyCache.has(resolved);
							const instrumented =
								!alreadyTracked && canProxyCurrentAssignment(resolved) ? proxy(resolved) : resolved;

							const result = defaultSet(target, prop, instrumented, receiver);

							if (result && !isInitializing()) commitSetInEdges(target, prop, previous, instrumented, truncated);

							return result;
						}

						if (refusesWrite(target, prop, resolved)) return false;

						const result = defaultSet(target, prop, resolved, receiver);

						if (result && !isInitializing()) commitSetInEdges(target, prop, previous, resolved, truncated);

						return result;
					} finally {
						setFrameStack.pop();

						if (assignmentStatus !== undefined && setFrameStack.length <= assignmentStatus.originIndex)
							assignmentStatus = undefined;
					}
				},
				deleteProperty(target, prop) {
					const previous: unknown = typeof prop === "string" ? Reflect.get(target, prop) : undefined;
					const result = defaultDelete(target, prop);

					if (result && !isInitializing()) commitDeleteInEdges(target, prop, previous);

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
