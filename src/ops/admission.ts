import { unstable_getInternalStates } from "valtio/vanilla";
import { isIgnored } from "../ignore";
import { bindVisitedOccupancy, markDirtyPath, type OccupancyVisit } from "../occupancy";
import { isUnsafeMarked } from "../unsafeTrack";
import { segmentFor, walkDataEntries } from "../utils/dataEntries";
import { admissionLane } from "../valtio/classify";
import { appendOperationPath, type OperationPath } from "./path";
import { isObjectLike } from "./predicates";
import type { DirtyIndex, Handle } from "../handle";

const { proxyStateMap } = unstable_getInternalStates();

const rawTargetOf = (value: object): object => proxyStateMap.get(value)?.[0] ?? value;

class MissingDiffParentError extends Error {
	constructor() {
		super("opshot: admitStep could not resolve a live parent");
		this.name = "MissingDiffParentError";
	}
}

export interface StepVerdict {
	readonly visit: OccupancyVisit;
	readonly ignored: boolean;
	readonly liveChild: unknown;
}

const isIgnoredValue = (value: unknown): boolean => isObjectLike(value) && isIgnored(value);

export const admitStep = (
	handle: Handle | undefined,
	dirty: DirtyIndex | undefined,
	path: OperationPath,
	liveParent: unknown,
): StepVerdict => {
	if (path.length === 0) {
		return { visit: "continue", ignored: isIgnoredValue(liveParent), liveChild: liveParent };
	}

	const key = path[path.length - 1];
	const liveChild: unknown =
		isObjectLike(liveParent) && key !== undefined ? (Reflect.get(liveParent, key) as unknown) : undefined;
	const ignored = isIgnoredValue(liveChild);

	if (handle === undefined || key === undefined) {
		return { visit: "continue", ignored, liveChild };
	}

	if (dirty === undefined) return { visit: "continue", ignored, liveChild };

	if (ignored) return { visit: "skip", ignored, liveChild };

	if (!isObjectLike(liveParent)) throw new MissingDiffParentError();

	const parentExempt = handle.nodes.get(rawTargetOf(liveParent))?.exempt === true;
	const childExempt = isObjectLike(liveChild) && (isUnsafeMarked(liveChild) || isUnsafeMarked(rawTargetOf(liveChild)));

	return {
		visit: bindVisitedOccupancy(handle, path, liveParent, key, liveChild, parentExempt || childExempt),
		ignored,
		liveChild,
	};
};

export const admitDescendants = (
	handle: Handle | undefined,
	path: OperationPath,
	visits: Set<object>,
	liveNode: unknown,
	unsafe = false,
): void => {
	if (handle === undefined) return;

	if (!isObjectLike(liveNode)) return;

	const nodeKey = rawTargetOf(liveNode);

	if (visits.has(nodeKey)) return;

	visits.add(nodeKey);

	if (isIgnored(liveNode)) return;

	const nodeUnsafe = unsafe || handle.nodes.get(nodeKey)?.exempt === true;

	for (const entry of walkDataEntries(liveNode)) {
		if (typeof entry.value !== "object" || entry.value === null) continue;

		if (isIgnored(entry.value)) continue;

		const key = segmentFor(liveNode, entry.key);
		const childPath = appendOperationPath(path, key);
		const childUnsafe = nodeUnsafe || isUnsafeMarked(entry.value) || isUnsafeMarked(rawTargetOf(entry.value));
		const visit = bindVisitedOccupancy(handle, childPath, liveNode, entry.key, entry.value, childUnsafe);

		if (visit !== "continue") continue;

		admitDescendants(handle, childPath, visits, Reflect.get(liveNode, key) as unknown, childUnsafe);
	}
};

export const markChangedPath = (
	handle: Handle | undefined,
	dirty: DirtyIndex | undefined,
	path: OperationPath,
	liveParent: unknown,
): void => {
	if (handle === undefined || dirty === undefined || path.length === 0) return;

	if (!isObjectLike(liveParent)) return;

	markDirtyPath(dirty, handle, path, liveParent);
};

export const emitsSkippedOccupancy = (value: unknown): boolean =>
	isObjectLike(value) && admissionLane(value) === "untracked";
