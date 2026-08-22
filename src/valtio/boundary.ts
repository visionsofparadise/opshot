import { getUntracked } from "proxy-compare";
import { proxy, unstable_getInternalStates, unstable_replaceInternalFunction } from "valtio/vanilla";
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
import type { DeclarationTrie } from "../declarations";

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

let assignmentStatuses: Array<AssignmentStatus> | undefined;

const computeOutermostAssignment = (
	target: object,
	prop: string | symbol,
	originIndex: number,
): Array<AssignmentStatus> | undefined => {
	if (typeof prop !== "string") return undefined;

	const handles = handlesOf(target);

	if (handles.length === 0) return undefined;

	return handles.map((handle) => {
		const slot = slotStatusOf(handle, target, segmentForProp(target, prop));

		return {
			handle,
			ignored: slot.ignored,
			unsafe: slot.unsafe,
			chains: slot.chains,
			originIndex,
		};
	});
};

const statusOfCurrentAssignment = (): Array<AssignmentStatus> | undefined => {
	if (assignmentStatuses === undefined) return undefined;

	const originIndex = assignmentStatuses[0]?.originIndex;

	if (originIndex === undefined || setFrameStack.length <= originIndex + 1) return assignmentStatuses;

	for (let index = originIndex + 1; index < setFrameStack.length; index++) {
		const frame = setFrameStack[index];

		if (frame === undefined || typeof frame.prop !== "string") return assignmentStatuses;
	}

	return assignmentStatuses.map((assignment) => {
		let chains = assignment.chains;
		let unsafe = assignment.unsafe;
		let ignored = assignment.ignored;

		for (let index = assignment.originIndex + 1; index < setFrameStack.length; index++) {
			const frame = setFrameStack[index];

			if (frame === undefined || typeof frame.prop !== "string") return assignment;

			const descended = descendChains(chains, segmentForProp(frame.target, frame.prop));

			ignored = ignored || descended.ignored;
			unsafe = unsafe || descended.unsafe;
			chains = descended.chains;
		}

		return {
			handle: assignment.handle,
			chains,
			unsafe,
			ignored,
			originIndex: assignment.originIndex,
		};
	});
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
	chains: ReadonlyArray<DeclarationTrie | undefined>,
	ignored: boolean,
	unsafe: boolean,
): void => {
	const node = mode === "admission" ? rawTargetOf(value) : value;

	if (visits.has(node)) return;

	visits.add(node);

	if (ignored) return;

	for (const entry of walkDataEntries(node)) {
		const childPath = [...path, entry.key];
		const descended = descendChains(chains, segmentForProp(node, entry.key));
		const childIgnored = descended.ignored;
		const childUnsafe = unsafe || descended.unsafe;
		const childChains = descended.chains;
		const child: unknown = entry.value;

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
				walkDataPaths(childNode, childPath, visits, mode, childChains, childIgnored, childUnsafe);

				continue;
			}

			if (certifyAdmission(childNode, childPath, childUnsafe) === "tracked")
				walkDataPaths(childNode, childPath, visits, mode, childChains, childIgnored, childUnsafe);

			continue;
		}

		if (admissionLane(childNode) === "untracked") continue;

		walkDataPaths(childNode, childPath, visits, mode, childChains, childIgnored, childUnsafe);
	}
};

export const assertSafeDataPaths = (
	value: object,
	path: Array<string>,
	visits: Set<object>,
	mode: DataPathWalkMode = "admission",
	chains: ReadonlyArray<DeclarationTrie | undefined> = [],
): void => {
	walkDataPaths(
		value,
		path,
		visits,
		mode,
		chains,
		chains.some((residual) => residual?.ignored === true),
		chains.some((residual) => residual?.unsafe === true),
	);
};

const certifyCurrentAssignment = (target: object, prop: string | symbol, resolved: object): void => {
	if (typeof prop !== "string") return;

	const assignments = statusOfCurrentAssignment();

	if (assignments === undefined) return;

	const path = [prop];

	for (const assignment of assignments) {
		if (!assignment.handle.strict || assignment.ignored || assignment.unsafe) continue;

		if (typeof resolved === "function") {
			const parentKind = classifyValue(rawTargetOf(target));

			if (parentKind !== "plain" && parentKind !== "plainArray")
				throw rejectionError(rawTargetOf(target), parentKind, path);

			continue;
		}

		const decision = admissionDecision(resolved);

		if (decision.lane === "dangerous") throw rejectionError(resolved, decision.kind, path);

		if (decision.lane === "tracked")
			walkDataPaths(
				resolved,
				path,
				new Set(),
				"admission",
				assignment.chains,
				assignment.ignored,
				assignment.unsafe,
			);
	}
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
	const assignments = statusOfCurrentAssignment();

	if (assignments === undefined) return canProxy(value, currentSetParentOf());

	const judging = assignments.filter((assignment) => !assignment.ignored);

	if (judging.length === 0) return false;

	return canProxy(
		value,
		currentSetParentOf(),
		judging.every((assignment) => assignment.unsafe || !assignment.handle.strict),
	);
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

					assignmentStatuses ??= computeOutermostAssignment(target, prop, originIndex);

					setFrameStack.push({ target, prop });

					try {
						if (typeof resolved === "object" && resolved !== null) {
							if (getRegisteredTarget(resolved) !== undefined) throw snapshotDonationError(prop);

							if (refusesWrite(target, prop, resolved)) return false;

							certifyCurrentAssignment(target, prop, resolved);

							const alreadyTracked = proxyStateMap.has(resolved) || proxyCache.has(resolved);
							const instrumented =
								!alreadyTracked && canProxyCurrentAssignment(resolved) ? proxy(resolved) : resolved;

							const result = defaultSet(target, prop, instrumented, receiver);

							if (result && !isInitializing()) commitSetInEdges(target, prop, previous, instrumented, truncated);

							return result;
						}

						if (refusesWrite(target, prop, resolved)) return false;

						if (typeof resolved === "function") certifyCurrentAssignment(target, prop, resolved);

						const result = defaultSet(target, prop, resolved, receiver);

						if (result && !isInitializing()) commitSetInEdges(target, prop, previous, resolved, truncated);

						return result;
					} finally {
						setFrameStack.pop();

						if (
							assignmentStatuses !== undefined &&
							setFrameStack.length <= (assignmentStatuses[0]?.originIndex ?? 0)
						)
							assignmentStatuses = undefined;
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
