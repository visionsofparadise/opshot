import { hasInEdge } from "./edges";
import { getRegisteredTarget } from "./identity";
import { isIgnored } from "./ignore";
import { internNode } from "./intern";
import { appendOperationPath, createOperationPath, type OperationPath } from "./ops/path";
import { isObjectLike } from "./ops/predicates";
import { isUnsafeMarked } from "./unsafeTrack";
import { segmentFor, walkDataEntries } from "./utils/dataEntries";
import { admissionDecision, classifyValue } from "./valtio/classify";
import { rawTargetOf } from "./valtio/rawTarget";
import type { DirtyIndex, Handle } from "./handle";

const liveOf = (value: object): object => getRegisteredTarget(value) ?? rawTargetOf(value);

export type OccupancyVisit = "skip" | "continue";

const occupancyKeyOf = (key: string | number | symbol): string | symbol =>
	typeof key === "number" ? String(key) : key;

export function bindVisitedOccupancy(
	handle: Handle,
	path: OperationPath,
	parent: object,
	key: string | number,
	child: unknown,
	unsafe = false,
): OccupancyVisit {
	if (path.length === 0) return "continue";

	if (typeof child === "object" && child !== null && isIgnored(child) && !hasInEdge(handle, child, parent, key))
		return "skip";

	const parentRaw = liveOf(parent);
	const occupancyKey = occupancyKeyOf(key);
	const admitted = unsafe || !handle.strict;

	if (typeof child === "function") {
		const parentKind = classifyValue(parentRaw);

		if (parentKind === "plain" || parentKind === "plainArray") return "continue";

		if (admitted) return "continue";

		return "skip";
	}

	const stored: unknown = Reflect.get(parentRaw, occupancyKey);
	const occupantSource = isObjectLike(stored) ? stored : child;

	if (typeof occupantSource !== "object" || occupantSource === null) return "continue";

	const childLive = liveOf(occupantSource);
	const descriptor = Reflect.getOwnPropertyDescriptor(parentRaw, occupancyKey);

	if (descriptor !== undefined && descriptor.writable !== true && admissionDecision(childLive).lane !== "untracked")
		return "skip";

	const decision = admissionDecision(childLive);

	if (decision.lane === "untracked") return "skip";

	if (decision.lane === "dangerous") {
		if (admitted) return "continue";

		return "skip";
	}

	if (!admitted && classifyValue(childLive) === "cleanClass") {
		for (const entry of walkDataEntries(childLive)) {
			if (typeof entry.value !== "function") continue;

			return "skip";
		}
	}

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

const walkLiveOccupancies = (handle: Handle): void => {
	const root = handle.proxy.root;
	const visits = new Set<object>();

	const walk = (node: object, path: OperationPath, parent?: object, parentKey?: string | number): void => {
		if (
			isIgnored(node) &&
			(parent === undefined || parentKey === undefined || !hasInEdge(handle, node, parent, parentKey))
		)
			return;

		internNode(handle, node);

		const nodeRaw = rawTargetOf(node);

		if (visits.has(nodeRaw)) return;

		visits.add(nodeRaw);

		const nodeExempt = handle.nodes.get(nodeRaw)?.exempt === true;

		for (const entry of walkDataEntries(node)) {
			const key = segmentFor(node, entry.key);

			if (
				typeof entry.value === "object" &&
				entry.value !== null &&
				isIgnored(entry.value) &&
				!hasInEdge(handle, entry.value, node, key)
			)
				continue;

			const childPath = appendOperationPath(path, key);
			const childUnsafe =
				nodeExempt ||
				(typeof entry.value === "object" &&
					entry.value !== null &&
					(isUnsafeMarked(entry.value) || isUnsafeMarked(rawTargetOf(entry.value))));
			const visit = bindVisitedOccupancy(handle, childPath, node, entry.key, entry.value, childUnsafe);

			if (visit !== "continue") continue;

			if (typeof entry.value === "object" && entry.value !== null) walk(entry.value, childPath, node, key);
		}
	};

	walk(root, createOperationPath([]));
};

export function seedOccupancies(handle: Handle): void {
	walkLiveOccupancies(handle);
}
