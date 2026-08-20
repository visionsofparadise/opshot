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

export interface OccupancyTableSnapshot {
	readonly routes: Map<object, ReadonlyArray<OperationPath>>;
}

const occupancyRoutesByHandle = new WeakMap<Handle, Map<object, Array<OperationPath>>>();

const occupancyRefusals = new WeakMap<Handle, Array<Error>>();

const occupancyOmissions = new WeakMap<Handle, Set<string>>();

const occupancyKeyOf = (key: string | number | symbol): string | symbol =>
	typeof key === "number" ? String(key) : key;

const segmentFor = (parent: object, key: string): string | number =>
	isPlainArray(parent) && isCanonicalArrayIndexString(key) ? Number(key) : key;

export function beginOccupancyRefusals(handle: Handle): void {
	occupancyRefusals.set(handle, []);
	occupancyOmissions.set(handle, new Set());
}

export function occupancyRefusalsOf(handle: Handle): Array<Error> {
	return occupancyRefusals.get(handle) ?? [];
}

const occupancyRefusalErrors = new WeakSet<object>();

export function markOccupancyRefusal(error: Error): Error {
	occupancyRefusalErrors.add(error);

	return error;
}

export function isOccupancyRefusal(error: unknown): boolean {
	return typeof error === "object" && error !== null && occupancyRefusalErrors.has(error);
}

export function occupancyOmissionsOf(handle: Handle): Set<string> {
	return occupancyOmissions.get(handle) ?? new Set();
}

const pathKeyOf = (path: OperationPath): string => formatOperationPath(path);

const routeTableOf = (handle: Handle): Map<object, Array<OperationPath>> => {
	let table = occupancyRoutesByHandle.get(handle);

	if (table === undefined) {
		table = new Map();
		occupancyRoutesByHandle.set(handle, table);
	}

	return table;
};

const publishRoutes = (handle: Handle, node: object, paths: ReadonlyArray<OperationPath>): void => {
	const raw = rawTargetOf(node);
	const table = routeTableOf(handle);

	if (paths.length === 0) {
		table.delete(raw);
		handle.routes.delete(raw);
		handle.members.delete(raw);

		return;
	}

	const copy = [...paths];

	table.set(raw, copy);
	handle.routes.set(raw, copy);
	handle.members.add(raw);
	registerHandle(raw, handle);
};

export function addOccupancyRoute(handle: Handle, node: object, path: OperationPath): void {
	const raw = rawTargetOf(node);
	const existing = routeTableOf(handle).get(raw) ?? [];

	if (existing.some((occupied) => operationPathsEqual(occupied, path))) return;

	publishRoutes(handle, raw, [...existing, path]);
}

export function dropOccupancyRoutesUnder(handle: Handle, path: OperationPath): void {
	const table = occupancyRoutesByHandle.get(handle);

	if (table === undefined) return;

	for (const [node, paths] of table) {
		const next = paths.filter((occupied) => !routeUnderPath(occupied, path));

		if (next.length === paths.length) continue;

		publishRoutes(handle, node, next);
	}
}

export function restoreOccupancyTables(handle: Handle, snapshot: OccupancyTableSnapshot): void {
	const table = routeTableOf(handle);

	for (const node of [...table.keys()]) {
		if (snapshot.routes.has(node)) continue;

		table.delete(node);
		handle.routes.delete(node);
		handle.members.delete(node);
	}

	for (const [node, paths] of snapshot.routes) {
		publishRoutes(handle, node, paths);
	}
}

export function copyOccupancyTables(handle: Handle): OccupancyTableSnapshot {
	const routes = new Map<object, ReadonlyArray<OperationPath>>();
	const table = occupancyRoutesByHandle.get(handle);

	if (table !== undefined) {
		for (const [node, paths] of table) routes.set(node, [...paths]);
	}

	return { routes };
}

const pathAsStrings = (path: OperationPath): Array<string> => path.map((segment) => String(segment));

const collectRefusal = (handle: Handle, error: Error, pathKey: string): void => {
	const refusals = occupancyRefusals.get(handle);

	if (refusals === undefined) occupancyRefusals.set(handle, [error]);
	else refusals.push(error);

	const omissions = occupancyOmissions.get(handle);

	if (omissions === undefined) occupancyOmissions.set(handle, new Set([pathKey]));
	else omissions.add(pathKey);
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
	sameOccupant = false,
	unsafe = false,
): OccupancyVisit {
	if (path.length === 0) return "continue";

	if (isUnderIgnoredOccupancy(handle, path)) return "skip";

	const pathKey = pathKeyOf(path);
	const parentRaw = liveOf(parent);
	const occupancyKey = occupancyKeyOf(key);
	const admitted = unsafe || !handle.strict;

	if (typeof child === "function") {
		const parentKind = classifyValue(parentRaw);

		if (parentKind === "plain" || parentKind === "plainArray") return "continue";

		if (admitted || sameOccupant) return "continue";

		collectRefusal(handle, rejectionError(parentRaw, parentKind, pathAsStrings(path)), pathKey);

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

		collectRefusal(handle, nonWritablePropertyError(childLive, pathAsStrings(path)), pathKey);

		return "omit";
	}

	const decision = admissionDecision(childLive);

	if (decision.lane === "untracked") return "skip";

	if (decision.lane === "dangerous") {
		if (admitted) {
			addOccupancyRoute(handle, childLive, path);

			return "continue";
		}

		if (sameOccupant) return "skip";

		collectRefusal(handle, rejectionError(childLive, decision.kind, pathAsStrings(path)), pathKey);

		return "omit";
	}

	if (!admitted && classifyValue(childLive) === "cleanClass") {
		for (const entry of walkDataEntries(childLive)) {
			if (typeof entry.value !== "function") continue;

			if (sameOccupant) break;

			collectRefusal(
				handle,
				rejectionError(childLive, "cleanClass", pathAsStrings(appendOperationPath(path, entry.key))),
				pathKey,
			);

			return "omit";
		}
	}

	addOccupancyRoute(handle, childLive, path);

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

const walkLiveOccupancies = (handle: Handle, sameOccupant: boolean): void => {
	const root = handle.proxy.root;

	addOccupancyRoute(handle, rawTargetOf(root), createOperationPath([]));

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
			const visit = bindVisitedOccupancy(handle, childPath, node, entry.key, entry.value, sameOccupant, childUnsafe);

			if (visit !== "continue") continue;

			if (typeof entry.value === "object" && entry.value !== null) walk(entry.value, childPath, childUnsafe);
		}
	};

	walk(root, createOperationPath([]), false);
};

export function seedOccupancies(handle: Handle): void {
	walkLiveOccupancies(handle, false);
}

export function syncHandleTables(handle: Handle): void {
	walkLiveOccupancies(handle, true);
}
