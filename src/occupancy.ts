import { unstable_getInternalStates } from "valtio/vanilla";
import { registerHandle, type DirtyIndex, type Handle } from "./handle";
import { getRegisteredTarget } from "./identity";
import { isPlainArray } from "./ops/cloneValue";
import { routeUnderPath } from "./ops/commitWalk";
import {
	appendOperationPath,
	createOperationPath,
	formatOperationPath,
	operationPathsEqual,
	type OperationPath,
} from "./ops/path";
import { isCanonicalArrayIndexString, isObjectLike } from "./ops/predicates";
import { walkDataEntries } from "./utils/dataEntries";
import { nonWritablePropertyError, rejectionError } from "./valtio/boundaryErrors";
import { admissionDecision, classifyValue } from "./valtio/classify";

const { proxyStateMap } = unstable_getInternalStates();

const rawTargetOf = (value: object): object => proxyStateMap.get(value)?.[0] ?? value;

const liveOf = (value: object): object => getRegisteredTarget(value) ?? rawTargetOf(value);

export type OccupancyVisit = "omit" | "skip" | "continue";

export interface CaptureTables {
	refusals: Array<Error>;
	omissions: Set<string>;
	routes: {
		added: Map<object, Array<OperationPath>>;
		droppedUnder: Array<OperationPath>;
		firstTouched: Map<object, OperationPath>;
	};
}

export const createCaptureTables = (): CaptureTables => ({
	refusals: [],
	omissions: new Set(),
	routes: {
		added: new Map(),
		droppedUnder: [],
		firstTouched: new Map(),
	},
});

export class OccupancyRefusalError extends Error {
	constructor(refusal: Error) {
		super(refusal.message, refusal instanceof AggregateError ? { cause: refusal } : undefined);
		this.name = "OccupancyRefusalError";
	}
}

const occupancyKeyOf = (key: string | number | symbol): string | symbol =>
	typeof key === "number" ? String(key) : key;

const segmentFor = (parent: object, key: string): string | number =>
	isPlainArray(parent) && isCanonicalArrayIndexString(key) ? Number(key) : key;

const pathKeyOf = (path: OperationPath): string => formatOperationPath(path);

const occupancyNodeOf = (node: object): object => rawTargetOf(liveOf(node));

const publishRoutes = (handle: Handle, node: object, paths: ReadonlyArray<OperationPath>): void => {
	const raw = occupancyNodeOf(node);

	if (paths.length === 0) {
		handle.routes.delete(raw);

		return;
	}

	const copy = [...paths];

	handle.routes.set(raw, copy);
	registerHandle(raw, handle);
};

const recordFirstTouched = (capture: CaptureTables, node: object, path: OperationPath): void => {
	const raw = occupancyNodeOf(node);

	if (!capture.routes.firstTouched.has(raw)) capture.routes.firstTouched.set(raw, path);
};

const isDroppedUnder = (capture: CaptureTables, route: OperationPath): boolean =>
	capture.routes.droppedUnder.some((dropped) => routeUnderPath(route, dropped));

export function predatingRoutesOf(handle: Handle, node: object): ReadonlyArray<OperationPath> {
	return handle.routes.get(occupancyNodeOf(node)) ?? [];
}

export function overlayRoutesOf(handle: Handle, capture: CaptureTables, node: object): ReadonlyArray<OperationPath> {
	const raw = occupancyNodeOf(node);
	const kept = (handle.routes.get(raw) ?? []).filter((route) => !isDroppedUnder(capture, route));
	const added = capture.routes.added.get(raw) ?? [];

	if (added.length === 0) return kept;

	const merged = [...kept];

	for (const path of added) {
		if (merged.some((occupied) => operationPathsEqual(occupied, path))) continue;

		merged.push(path);
	}

	return merged;
}

export function addOccupancyRoute(handle: Handle, node: object, path: OperationPath, capture?: CaptureTables): void {
	const raw = occupancyNodeOf(node);

	if (capture === undefined) {
		const existing = handle.routes.get(raw) ?? [];

		if (existing.some((occupied) => operationPathsEqual(occupied, path))) return;

		publishRoutes(handle, raw, [...existing, path]);

		return;
	}

	recordFirstTouched(capture, raw, path);

	const existing = overlayRoutesOf(handle, capture, raw);

	if (existing.some((occupied) => operationPathsEqual(occupied, path))) return;

	const added = capture.routes.added.get(raw) ?? [];

	capture.routes.added.set(raw, [...added, path]);
}

export function dropOccupancyRoutesUnder(path: OperationPath, capture: CaptureTables): void {
	capture.routes.droppedUnder.push(path);
}

const dropBaseRoutesUnder = (handle: Handle, path: OperationPath): void => {
	for (const [node, paths] of handle.routes) {
		const next = paths.filter((occupied) => !routeUnderPath(occupied, path));

		if (next.length === paths.length) continue;

		publishRoutes(handle, node, next);
	}
};

export function commitCapture(handle: Handle, capture: CaptureTables): void {
	for (const path of capture.routes.droppedUnder) dropBaseRoutesUnder(handle, path);

	for (const [node, paths] of capture.routes.added) {
		const existing = handle.routes.get(occupancyNodeOf(node)) ?? [];
		const next = [...existing];

		for (const path of paths) {
			if (next.some((occupied) => operationPathsEqual(occupied, path))) continue;

			next.push(path);
		}

		publishRoutes(handle, node, next);
	}
}

const pathAsStrings = (path: OperationPath): Array<string> => path.map((segment) => String(segment));

const collectRefusal = (capture: CaptureTables, error: Error, pathKey: string): void => {
	capture.refusals.push(error);
	capture.omissions.add(pathKey);
};

const occupancySetHasPrefix = (flags: ReadonlySet<string>, path: OperationPath): boolean => {
	if (flags.has("/")) return true;

	let prefix = createOperationPath([]);

	for (const segment of path) {
		prefix = appendOperationPath(prefix, segment);

		if (flags.has(pathKeyOf(prefix))) return true;
	}

	return false;
};

export function isUnderIgnoredOccupancy(handle: Handle, path: OperationPath): boolean {
	return occupancySetHasPrefix(handle.ignoredAt, path);
}

export function isUnderUnsafeOccupancy(handle: Handle, path: OperationPath): boolean {
	return occupancySetHasPrefix(handle.unsafeAt, path);
}

export function bindVisitedOccupancy(
	handle: Handle,
	path: OperationPath,
	parent: object,
	key: string | number,
	child: unknown,
	capture: CaptureTables,
	sameOccupant = false,
	unsafe = false,
	overlay = true,
): OccupancyVisit {
	if (path.length === 0) return "continue";

	if (isUnderIgnoredOccupancy(handle, path)) return "skip";

	const pathKey = pathKeyOf(path);

	if (capture.omissions.has(pathKey)) return "omit";

	const parentRaw = liveOf(parent);
	const occupancyKey = occupancyKeyOf(key);
	const admitted = unsafe || !handle.strict;

	if (typeof child === "function") {
		const parentKind = classifyValue(parentRaw);

		if (parentKind === "plain" || parentKind === "plainArray") return "continue";

		if (admitted || sameOccupant) return "continue";

		collectRefusal(capture, rejectionError(parentRaw, parentKind, pathAsStrings(path)), pathKey);

		return "omit";
	}

	const stored: unknown = Reflect.get(parentRaw, occupancyKey);
	const occupantSource = isObjectLike(stored) ? stored : child;

	if (typeof occupantSource !== "object" || occupantSource === null) return "continue";

	const childLive = liveOf(occupantSource);
	const descriptor = Reflect.getOwnPropertyDescriptor(parentRaw, occupancyKey);

	if (descriptor !== undefined && descriptor.writable !== true && admissionDecision(childLive).lane !== "untracked") {
		if (admitted) return "skip";

		if (sameOccupant) return "skip";

		collectRefusal(capture, nonWritablePropertyError(childLive, pathAsStrings(path)), pathKey);

		return "omit";
	}

	const decision = admissionDecision(childLive);

	if (decision.lane === "untracked") return "skip";

	if (decision.lane === "dangerous") {
		if (admitted) {
			if (overlay) recordFirstTouched(capture, childLive, path);

			addOccupancyRoute(handle, childLive, path, overlay ? capture : undefined);

			return "continue";
		}

		if (sameOccupant) return "skip";

		collectRefusal(capture, rejectionError(childLive, decision.kind, pathAsStrings(path)), pathKey);

		return "omit";
	}

	if (!admitted && classifyValue(childLive) === "cleanClass") {
		for (const entry of walkDataEntries(childLive)) {
			if (typeof entry.value !== "function") continue;

			if (sameOccupant) break;

			collectRefusal(
				capture,
				rejectionError(childLive, "cleanClass", pathAsStrings(appendOperationPath(path, entry.key))),
				pathKey,
			);

			return "omit";
		}
	}

	if (overlay) recordFirstTouched(capture, childLive, path);

	addOccupancyRoute(handle, childLive, path, overlay ? capture : undefined);

	return "continue";
}

export function markDirtyPath(
	dirty: DirtyIndex,
	handle: Handle,
	path: OperationPath,
	parentLive: object | undefined,
): void {
	let current: unknown = handle.proxy.root;

	if (isObjectLike(current)) dirty.nodes.add(rawTargetOf(current));

	for (const segment of path) {
		if (!isObjectLike(current)) break;

		current = Reflect.get(current, segment);

		if (isObjectLike(current)) dirty.nodes.add(rawTargetOf(current));
	}

	if (parentLive === undefined || path.length === 0) return;

	const lastSegment = path[path.length - 1];

	if (lastSegment === undefined) return;

	const edge = typeof lastSegment === "number" ? String(lastSegment) : lastSegment;
	const parentRaw = rawTargetOf(parentLive);
	let edges = dirty.edges.get(parentRaw);

	if (edges === undefined) {
		edges = new Set();
		dirty.edges.set(parentRaw, edges);
	}

	edges.add(edge);
}

const walkLiveOccupancies = (handle: Handle, sameOccupant: boolean, capture: CaptureTables, overlay: boolean): void => {
	const root = handle.proxy.root;

	addOccupancyRoute(handle, rawTargetOf(root), createOperationPath([]), overlay ? capture : undefined);

	const visits = new Set<object>();

	const walk = (node: object, path: OperationPath, unsafe: boolean): void => {
		const nodeRaw = rawTargetOf(node);

		if (visits.has(nodeRaw)) return;

		visits.add(nodeRaw);

		const nodeUnsafe = unsafe || isUnderUnsafeOccupancy(handle, path);

		if (handle.ignoredAt.has(pathKeyOf(path))) return;

		for (const entry of walkDataEntries(node)) {
			const childPath = appendOperationPath(path, segmentFor(node, entry.key));
			const childUnsafe = nodeUnsafe || handle.unsafeAt.has(pathKeyOf(childPath));
			const visit = bindVisitedOccupancy(
				handle,
				childPath,
				node,
				entry.key,
				entry.value,
				capture,
				sameOccupant,
				childUnsafe,
				overlay,
			);

			if (visit !== "continue") continue;

			if (typeof entry.value === "object" && entry.value !== null) walk(entry.value, childPath, childUnsafe);
		}
	};

	walk(root, createOperationPath([]), false);
};

export function seedOccupancies(handle: Handle): void {
	walkLiveOccupancies(handle, false, createCaptureTables(), false);
}

export function syncHandleTables(handle: Handle, capture: CaptureTables): void {
	walkLiveOccupancies(handle, true, capture, true);
}
