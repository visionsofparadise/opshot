import { unstable_getInternalStates } from "valtio/vanilla";
import {
	childChainsOf,
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
	readonly chains: ChainSet;
}

export const admitStep = (
	handle: Handle | undefined,
	dirty: DirtyIndex | undefined,
	path: OperationPath,
	liveParent: unknown,
	residual: ChainSet,
): StepVerdict => {
	if (path.length === 0) {
		return { visit: "continue", ignored: isChainsIgnored(residual), liveChild: liveParent, chains: residual };
	}

	const key = path[path.length - 1];
	const liveChild: unknown =
		isObjectLike(liveParent) && key !== undefined ? (Reflect.get(liveParent, key) as unknown) : undefined;
	const childChains = key === undefined ? residual : childChainsOf(residual, key);
	const ignored =
		isChainsIgnored(childChains) ||
		(handle !== undefined &&
			isObjectLike(liveParent) &&
			key !== undefined &&
			isIgnoredFrontier(handle, liveParent, key));

	if (handle === undefined || dirty === undefined) {
		return { visit: "continue", ignored, liveChild, chains: childChains };
	}

	if (ignored) return { visit: "skip", ignored, liveChild, chains: childChains };

	if (!isObjectLike(liveParent) || key === undefined) throw new MissingDiffParentError();

	const slot = slotStatusOf(handle, liveParent, key);
	let unsafe = slot.occupied ? slot.unsafe : isChainsUnsafe(childChains);

	if (isObjectLike(liveChild)) {
		const status = edgeStatusOf(handle, liveChild);

		if (status.occupied) unsafe = status.unsafe;
	}

	return {
		visit: bindVisitedOccupancy(handle, path, liveParent, key, liveChild, unsafe),
		ignored,
		liveChild,
		chains: childChains,
	};
};

export const admitDescendants = (
	handle: Handle | undefined,
	path: OperationPath,
	visits: Set<object>,
	residual: ChainSet,
	liveNode: unknown,
	unsafe = false,
): void => {
	if (handle === undefined) return;

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

		admitDescendants(handle, childPath, visits, childChains, Reflect.get(liveNode, key) as unknown, childUnsafe);
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
