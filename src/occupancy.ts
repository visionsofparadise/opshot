import { unstable_getInternalStates } from "valtio/vanilla";
import { registerHandle, unregisterHandle, type Handle } from "./handle";
import { getRegisteredTarget, isSameIdentity } from "./identity";
import { appendOperationPath, createOperationPath, formatOperationPath, type OperationPath } from "./ops/path";
import { isObjectLike } from "./ops/predicates";
import { walkDataEntries } from "./utils/dataEntries";
import { nonWritablePropertyError, rejectionError } from "./valtio/boundaryErrors";
import { admissionDecision, classifyValue } from "./valtio/classify";

const { proxyStateMap } = unstable_getInternalStates();

const rawTargetOf = (value: object): object => proxyStateMap.get(value)?.[0] ?? value;

const liveOf = (value: object): object => getRegisteredTarget(value) ?? rawTargetOf(value);

export type PendingKind = "ignore" | "unsafe";

interface PendingRecord {
	readonly child: object;
	readonly kind: PendingKind;
}

const pendingByParent = new WeakMap<object, Map<string | symbol, PendingRecord>>();

const occupancyPathsByHandle = new WeakMap<Handle, Map<object, Set<string>>>();

const occupancyRefusals = new WeakMap<Handle, Array<Error>>();

const occupancyOmissions = new WeakMap<Handle, Set<string>>();

const occupancyKeyOf = (key: string | number | symbol): string | symbol =>
	typeof key === "number" ? String(key) : key;

export function recordPendingOccupancy(
	parentRaw: object,
	key: string | symbol,
	child: object,
	kind: PendingKind,
): void {
	let records = pendingByParent.get(parentRaw);

	if (records === undefined) {
		records = new Map();
		pendingByParent.set(parentRaw, records);
	}

	records.set(key, { child, kind });
}

export function takePendingOccupancy(parentRaw: object, key: string | symbol, child: object): PendingKind | undefined {
	const records = pendingByParent.get(parentRaw);

	if (records === undefined) return undefined;

	const record = records.get(key);

	if (record?.child !== child) return undefined;

	records.delete(key);

	if (records.size === 0) pendingByParent.delete(parentRaw);

	return record.kind;
}

function discardPendingOccupanciesOn(parentRaw: object): void {
	pendingByParent.delete(parentRaw);
}

export function discardPendingOccupanciesForHandle(handle: Handle): void {
	discardPendingOccupanciesOn(rawTargetOf(handle.proxy.root));

	const byNode = occupancyPathsByHandle.get(handle);

	if (byNode === undefined) return;

	for (const node of byNode.keys()) discardPendingOccupanciesOn(node);
}

function beginOccupancyRefusals(handle: Handle): void {
	occupancyRefusals.set(handle, []);
	occupancyOmissions.set(handle, new Set());
}

export function occupancyRefusalsOf(handle: Handle): Array<Error> {
	return occupancyRefusals.get(handle) ?? [];
}

export function occupancyOmissionsOf(handle: Handle): Set<string> {
	return occupancyOmissions.get(handle) ?? new Set();
}

const pathKeyOf = (path: OperationPath): string => formatOperationPath(path);

const isAtOrUnderPath = (candidate: string, prefix: string): boolean =>
	candidate === prefix || (prefix === "/" ? candidate.startsWith("/") : candidate.startsWith(`${prefix}/`));

const rememberOccupancy = (handle: Handle, node: object, pathKey: string): void => {
	let byNode = occupancyPathsByHandle.get(handle);

	if (byNode === undefined) {
		byNode = new Map();
		occupancyPathsByHandle.set(handle, byNode);
	}

	let paths = byNode.get(node);

	if (paths === undefined) {
		paths = new Set();
		byNode.set(node, paths);
	}

	paths.add(pathKey);
	registerHandle(node, handle);
};

const forgetOccupancyPath = (handle: Handle, pathKey: string): void => {
	const byNode = occupancyPathsByHandle.get(handle);

	if (byNode === undefined) return;

	const rootRaw = rawTargetOf(handle.proxy.root);

	for (const [node, paths] of byNode) {
		let removed = false;

		for (const occupied of [...paths]) {
			if (!isAtOrUnderPath(occupied, pathKey)) continue;

			paths.delete(occupied);
			removed = true;
		}

		if (!removed || paths.size > 0) continue;

		byNode.delete(node);

		if (node !== rootRaw) unregisterHandle(node, handle);
	}
};

export function restoreOccupancyTables(
	handle: Handle,
	ignoredAt: Map<string, object>,
	unsafeAt: Map<string, object>,
): void {
	handle.ignoredAt = ignoredAt;
	handle.unsafeAt = unsafeAt;
}

export function copyOccupancyTables(handle: Handle): {
	readonly ignoredAt: Map<string, object>;
	readonly unsafeAt: Map<string, object>;
} {
	return {
		ignoredAt: new Map(handle.ignoredAt),
		unsafeAt: new Map(handle.unsafeAt),
	};
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

export function isUnderIgnoredOccupancy(handle: Handle, path: OperationPath): boolean {
	let prefix = createOperationPath([]);

	for (const segment of path) {
		prefix = appendOperationPath(prefix, segment);

		if (handle.ignoredAt.has(pathKeyOf(prefix))) return true;
	}

	return false;
}

type OccupancyVisit = "omit" | "skip" | "continue";

const valueAtPath = (root: object, path: OperationPath): unknown => {
	let current: unknown = root;

	for (const segment of path) {
		if (!isObjectLike(current)) return undefined;

		current = Reflect.get(current, segment);
	}

	return current;
};

function bindVisitedOccupancy(
	handle: Handle,
	path: OperationPath,
	parent: object,
	key: string | number,
	child: unknown,
	sameOccupant = false,
): OccupancyVisit {
	if (path.length === 0) return "continue";

	if (isUnderIgnoredOccupancy(handle, path.slice(0, -1))) return "skip";

	const pathKey = pathKeyOf(path);
	const parentRaw = liveOf(parent);
	const occupancyKey = occupancyKeyOf(key);

	if (typeof child === "function") {
		const parentKind = classifyValue(parentRaw);

		if (parentKind === "plain" || parentKind === "plainArray") return "continue";

		const parentPathKey = pathKeyOf(path.slice(0, -1));
		const parentUnsafe = !handle.strict || handle.unsafeAt.get(parentPathKey) === parentRaw;

		if (parentUnsafe || sameOccupant) return "continue";

		collectRefusal(handle, rejectionError(parentRaw, parentKind, pathAsStrings(path)), pathKey);

		return "omit";
	}

	if (typeof child !== "object" || child === null) return "continue";

	const childLive = liveOf(child);
	const kind =
		takePendingOccupancy(parentRaw, occupancyKey, childLive) ??
		(child !== childLive ? takePendingOccupancy(parentRaw, occupancyKey, child) : undefined);
	const descriptor = Reflect.getOwnPropertyDescriptor(parentRaw, occupancyKey);

	const ignoredOccupant = handle.ignoredAt.get(pathKey);
	const unsafeOccupant = handle.unsafeAt.get(pathKey);

	if (kind === "ignore" || (ignoredOccupant !== undefined && isSameIdentity(ignoredOccupant, childLive))) {
		handle.ignoredAt.set(pathKey, childLive);
		handle.unsafeAt.delete(pathKey);
		forgetOccupancyPath(handle, pathKey);

		return "skip";
	}

	if (kind === "unsafe") handle.unsafeAt.set(pathKey, childLive);

	if (ignoredOccupant !== undefined && !isSameIdentity(ignoredOccupant, childLive)) {
		handle.ignoredAt.delete(pathKey);
	}

	if (unsafeOccupant !== undefined && !isSameIdentity(unsafeOccupant, childLive) && kind !== "unsafe") {
		handle.unsafeAt.delete(pathKey);
	}

	if (descriptor !== undefined && descriptor.writable !== true && admissionDecision(childLive).lane !== "untracked") {
		if (sameOccupant && kind === undefined) return "skip";

		collectRefusal(handle, nonWritablePropertyError(childLive, pathAsStrings(path)), pathKey);

		return "omit";
	}

	const decision = admissionDecision(childLive);

	if (decision.lane === "untracked") return "skip";

	if (decision.lane === "dangerous") {
		const boundUnsafe = handle.unsafeAt.get(pathKey);
		const matchesUnsafe = boundUnsafe !== undefined && isSameIdentity(boundUnsafe, childLive);

		if (!handle.strict || matchesUnsafe || kind === "unsafe") {
			if (kind === "unsafe" || matchesUnsafe) {
				handle.unsafeAt.set(pathKey, childLive);
			}

			rememberOccupancy(handle, childLive, pathKey);

			return "continue";
		}

		if (sameOccupant) return "skip";

		collectRefusal(handle, rejectionError(childLive, decision.kind, pathAsStrings(path)), pathKey);

		return "omit";
	}

	rememberOccupancy(handle, childLive, pathKey);

	return "continue";
}

export function seedOccupancies(handle: Handle): void {
	const root = handle.proxy.root;
	const rootRaw = rawTargetOf(root);

	rememberOccupancy(handle, rootRaw, "/");

	const visits = new Set<object>();

	const walk = (node: object, path: OperationPath): void => {
		const nodeRaw = rawTargetOf(node);

		if (visits.has(nodeRaw)) return;

		visits.add(nodeRaw);

		if (handle.ignoredAt.get(pathKeyOf(path)) === nodeRaw) return;

		for (const entry of walkDataEntries(node)) {
			const childPath = appendOperationPath(path, entry.key);
			const visit = bindVisitedOccupancy(handle, childPath, node, entry.key, entry.value);

			if (visit !== "continue") continue;

			if (typeof entry.value === "object" && entry.value !== null) walk(entry.value, childPath);
		}
	};

	walk(root, createOperationPath([]));
}

export function reconcileOccupancies(handle: Handle, liveRoot: object, beforeRoot: object): void {
	beginOccupancyRefusals(handle);

	const visits = new Set<object>();
	const visitedPaths = new Set<string>(["/"]);

	const walk = (node: unknown, path: OperationPath, parent: object | undefined, key: string | undefined): void => {
		if (parent !== undefined && key !== undefined) {
			const pathKey = pathKeyOf(path);

			if (visitedPaths.has(pathKey)) return;

			visitedPaths.add(pathKey);

			const beforeChild = valueAtPath(beforeRoot, path);
			const beforeLive = isObjectLike(beforeChild) ? liveOf(beforeChild) : undefined;
			const afterLive = isObjectLike(node) ? liveOf(node) : undefined;
			const sameOccupant =
				beforeLive !== undefined && afterLive !== undefined && isSameIdentity(beforeLive, afterLive);
			const visit = bindVisitedOccupancy(handle, path, parent, key, node, sameOccupant);

			if (visit !== "continue") return;
		}

		if (typeof node !== "object" || node === null) return;

		const nodeRaw = rawTargetOf(node);

		if (visits.has(nodeRaw)) return;

		visits.add(nodeRaw);

		for (const entry of walkDataEntries(node)) {
			walk(entry.value, appendOperationPath(path, entry.key), node, entry.key);
		}
	};

	walk(liveRoot, createOperationPath([]), undefined, undefined);

	for (const key of [...handle.ignoredAt.keys()]) {
		if (!visitedPaths.has(key)) handle.ignoredAt.delete(key);
	}

	for (const key of [...handle.unsafeAt.keys()]) {
		if (!visitedPaths.has(key)) handle.unsafeAt.delete(key);
	}

	const byNode = occupancyPathsByHandle.get(handle);

	if (byNode === undefined) return;

	const rootRaw = rawTargetOf(handle.proxy.root);

	for (const [node, paths] of byNode) {
		for (const occupied of [...paths]) {
			if (!visitedPaths.has(occupied)) paths.delete(occupied);
		}

		if (paths.size > 0) continue;

		byNode.delete(node);

		if (node !== rootRaw) unregisterHandle(node, handle);
	}
}
