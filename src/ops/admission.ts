import { unstable_getInternalStates } from "valtio/vanilla";
import {
	descendChains,
	edgeStatusOf,
	isChainsIgnored,
	isChainsUnsafe,
	isIgnoredFrontier,
	slotStatusOf,
	type ChainSet,
} from "../edges";
import { bindVisitedOccupancy, markDirtyPath, type OccupancyVisit } from "../occupancy";
import { segmentFor, walkDataEntries } from "../utils/dataEntries";
import { admissionLane } from "../valtio/classify";
import { appendOperationPath, liveAtPath, type OperationPath } from "./path";
import { isObjectLike } from "./predicates";
import type { DirtyIndex, Handle } from "../handle";

const { proxyStateMap } = unstable_getInternalStates();

const rawTargetOf = (value: object): object => proxyStateMap.get(value)?.[0] ?? value;

class MissingDiffParentError extends Error {
	constructor() {
		super("opshot: admitEmitPath could not resolve a live parent");
		this.name = "MissingDiffParentError";
	}
}

export const admitEmitPath = (
	handle: Handle | undefined,
	dirty: DirtyIndex | undefined,
	path: OperationPath,
	residual: ChainSet,
): OccupancyVisit => {
	if (handle === undefined || dirty === undefined || path.length === 0) return "continue";

	if (isChainsIgnored(residual)) return "skip";

	const liveParent = liveAtPath(handle.proxy.root, path.slice(0, -1));
	const liveChild = liveAtPath(handle.proxy.root, path);
	const lastSegment = path[path.length - 1];

	if (isObjectLike(liveParent) && lastSegment !== undefined && isIgnoredFrontier(handle, liveParent, lastSegment))
		return "skip";

	if (!isObjectLike(liveParent) || lastSegment === undefined) throw new MissingDiffParentError();

	const slot = slotStatusOf(handle, liveParent, lastSegment);
	let unsafe = slot.occupied ? slot.unsafe : isChainsUnsafe(residual);

	if (isObjectLike(liveChild)) {
		const status = edgeStatusOf(handle, liveChild);

		if (status.occupied) unsafe = status.unsafe;
	}

	return bindVisitedOccupancy(handle, path, liveParent, lastSegment, liveChild, unsafe);
};

export const admitDescendants = (
	handle: Handle | undefined,
	path: OperationPath,
	visits: Set<object>,
	residual: ChainSet,
	unsafe = false,
): void => {
	if (handle === undefined) return;

	const liveNode = liveAtPath(handle.proxy.root, path);

	if (!isObjectLike(liveNode)) return;

	const nodeKey = rawTargetOf(liveNode);

	if (visits.has(nodeKey)) return;

	visits.add(nodeKey);

	if (isChainsIgnored(residual)) return;

	const nodeUnsafe = unsafe || isChainsUnsafe(residual);

	for (const entry of walkDataEntries(liveNode)) {
		if (typeof entry.value !== "object" || entry.value === null) continue;

		const key = segmentFor(liveNode, entry.key);
		const childPath = appendOperationPath(path, key);
		const slot = slotStatusOf(handle, liveNode, key);
		const descended = descendChains(residual, key);
		const ignored = slot.ignored || descended.ignored;
		const childChains = slot.occupied ? slot.chains : descended.chains;
		const childUnsafe = slot.occupied ? slot.unsafe : nodeUnsafe || descended.unsafe;

		if (ignored) continue;

		const visit = bindVisitedOccupancy(handle, childPath, liveNode, entry.key, entry.value, childUnsafe);

		if (visit !== "continue") continue;

		admitDescendants(handle, childPath, visits, childChains, childUnsafe);
	}
};

export const isIgnoredPath = (handle: Handle | undefined, path: OperationPath, residual: ChainSet): boolean => {
	if (isChainsIgnored(residual)) return true;

	if (handle === undefined || path.length === 0) return false;

	const parent = liveAtPath(handle.proxy.root, path.slice(0, -1));
	const key = path[path.length - 1];

	return isObjectLike(parent) && key !== undefined && isIgnoredFrontier(handle, parent, key);
};

export const markChangedPath = (
	handle: Handle | undefined,
	dirty: DirtyIndex | undefined,
	path: OperationPath,
): void => {
	if (handle === undefined || dirty === undefined || path.length === 0) return;

	const liveParent = liveAtPath(handle.proxy.root, path.slice(0, -1));

	if (!isObjectLike(liveParent)) return;

	markDirtyPath(dirty, handle, path, liveParent);
};

export const emitsSkippedOccupancy = (value: unknown): boolean =>
	isObjectLike(value) && admissionLane(value) === "untracked";
