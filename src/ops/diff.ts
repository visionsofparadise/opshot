import { unstable_getInternalStates } from "valtio/vanilla";
import { descendChains, edgeStatusOf, isIgnoredFrontier, slotStatusOf } from "../edges";
import { getRegisteredTarget, isSameIdentity } from "../identity";
import { internedIdOf, internSubtree, stageVend } from "../intern";
import {
	bindVisitedOccupancy,
	createCaptureTables,
	markDirtyPath,
	type CaptureTables,
	type OccupancyVisit,
} from "../occupancy";
import { walkDataEntries } from "../utils/dataEntries";
import { admissionLane } from "../valtio/classify";
import { isPlainArray, isPlainObject } from "./cloneValue";
import { createAssignMutation, createDeleteMutation, createLinkMutation, type Operation } from "./operation";
import { appendOperationPath, createOperationPath, formatOperationPath, liveAtPath, type OperationPath } from "./path";
import { isCanonicalArrayIndexString, isObjectLike } from "./predicates";
import type { DeclarationTrie } from "../declarations";
import type { DirtyIndex, Handle } from "../handle";

const { proxyStateMap } = unstable_getInternalStates();

const rawTargetOf = (value: object): object => proxyStateMap.get(value)?.[0] ?? value;

type RootKind = "plainObject" | "plainArray";
type Ancestors = Map<object, Set<object>>;

interface DiffContext {
	readonly ops: Array<Operation>;
	readonly ancestors: Ancestors;
	readonly handle: Handle | undefined;
	readonly dirty: DirtyIndex | undefined;
	readonly capture: CaptureTables;
}

class IncompatibleObjectRootsError extends Error {
	constructor() {
		super("opshot: diffObjects requires compatible supported object roots");
		this.name = "IncompatibleObjectRootsError";
	}
}

class MissingDiffParentError extends Error {
	constructor() {
		super("opshot: admitEmitPath could not resolve a live parent");
		this.name = "MissingDiffParentError";
	}
}

class MissingAncestorPairError extends Error {
	constructor() {
		super("opshot: exitAncestorPair without matching enterAncestorPair");
		this.name = "MissingAncestorPairError";
	}
}

const additionPair = (path: OperationPath, after: unknown): Operation => ({
	do: createAssignMutation(path, after),
	undo: createDeleteMutation(path),
});

const removalPair = (path: OperationPath, before: unknown): Operation => ({
	do: createDeleteMutation(path),
	undo: createAssignMutation(path, before),
});

const liveOf = (node: object): object => getRegisteredTarget(node) ?? node;

const occupancyNodeOf = (node: object): object => rawTargetOf(liveOf(node));

type ChainSet = ReadonlyArray<DeclarationTrie | undefined>;

const childChainsOf = (chains: ChainSet, key: string | number): ChainSet => descendChains(chains, key).chains;

const isChainsIgnored = (chains: ChainSet): boolean => chains.some((chain) => chain?.ignored === true);

const isChainsUnsafe = (chains: ChainSet): boolean => chains.length === 0;

const chainsAtRoot = (declarations: DeclarationTrie | undefined): ChainSet =>
	declarations?.unsafe === true ? [] : [declarations];

const segmentFor = (parent: object, key: string): string | number =>
	isPlainArray(parent) && isCanonicalArrayIndexString(key) ? Number(key) : key;

const writesTables = (context: DiffContext): context is DiffContext & { handle: Handle; dirty: DirtyIndex } =>
	context.handle !== undefined && context.dirty !== undefined;

const internedOccupied = (handle: Handle, node: object, capture?: CaptureTables): boolean =>
	internedIdOf(handle, node, capture) !== undefined && edgeStatusOf(handle, occupancyNodeOf(node)).occupied;

const interiorReachesInternedOccupied = (handle: Handle, node: object, capture?: CaptureTables): boolean => {
	const seen = new Set<object>();

	const visit = (current: object): boolean => {
		const raw = occupancyNodeOf(current);

		if (seen.has(raw)) return false;

		seen.add(raw);

		for (const entry of walkDataEntries(current)) {
			if (typeof entry.value !== "object" || entry.value === null) continue;

			if (internedOccupied(handle, entry.value, capture)) return true;

			if (visit(entry.value)) return true;
		}

		return false;
	};

	return visit(node);
};

const admitEmitPath = (
	context: DiffContext,
	path: OperationPath,
	before: unknown,
	after: unknown,
	beforePresent: boolean,
	residual: ChainSet,
): OccupancyVisit => {
	if (!writesTables(context) || path.length === 0) return "continue";

	if (isChainsIgnored(residual)) return "skip";

	const liveParent = liveAtPath(context.handle.proxy.root, path.slice(0, -1));
	const liveChild = liveAtPath(context.handle.proxy.root, path);
	const lastSegment = path[path.length - 1];

	if (
		isObjectLike(liveParent) &&
		lastSegment !== undefined &&
		isIgnoredFrontier(context.handle, liveParent, lastSegment)
	)
		return "skip";

	if (!isObjectLike(liveParent) || lastSegment === undefined) throw new MissingDiffParentError();

	const sameOccupant = beforePresent && sharesStorageIdentity(before, after);
	const slot = slotStatusOf(context.handle, liveParent, lastSegment);
	let unsafe = slot.occupied ? slot.unsafe : isChainsUnsafe(residual);

	if (isObjectLike(liveChild)) {
		const status = edgeStatusOf(context.handle, liveChild);

		if (status.occupied) unsafe = status.unsafe;
	}

	return bindVisitedOccupancy(
		context.handle,
		path,
		liveParent,
		lastSegment,
		liveChild,
		context.capture,
		sameOccupant,
		unsafe,
	);
};

const admitDescendants = (
	context: DiffContext,
	path: OperationPath,
	visits: Set<object> = new Set(),
	sameOccupant = false,
	residual: ChainSet,
	unsafe = false,
): void => {
	if (context.handle === undefined) return;

	const liveNode = liveAtPath(context.handle.proxy.root, path);

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
		const slot = slotStatusOf(context.handle, liveNode, key);
		const descended = descendChains(residual, key);
		const ignored = slot.ignored || descended.ignored;
		const childChains = slot.occupied ? slot.chains : descended.chains;
		const childUnsafe = slot.occupied ? slot.unsafe : nodeUnsafe || descended.unsafe;

		if (ignored) continue;

		const visit = bindVisitedOccupancy(
			context.handle,
			childPath,
			liveNode,
			entry.key,
			entry.value,
			context.capture,
			sameOccupant,
			childUnsafe,
		);

		if (visit !== "continue") continue;

		admitDescendants(context, childPath, visits, sameOccupant, childChains, childUnsafe);
	}
};

const linkUndo = (
	path: OperationPath,
	before: unknown,
	beforePresent: boolean,
	handle: Handle | undefined,
	capture?: CaptureTables,
): Operation["undo"] => {
	if (!beforePresent) return createDeleteMutation(path);

	if (handle !== undefined && isObjectLike(before) && internedOccupied(handle, before, capture)) {
		const id = internedIdOf(handle, before, capture);

		if (id !== undefined) return createLinkMutation(path, id);
	}

	return createAssignMutation(path, before);
};

const linkOperation = (
	path: OperationPath,
	ref: number,
	before: unknown,
	beforePresent: boolean,
	handle: Handle | undefined,
	capture?: CaptureTables,
): Operation => ({
	do: createLinkMutation(path, ref),
	undo: linkUndo(path, before, beforePresent, handle, capture),
});

const changePair = (
	path: OperationPath,
	before: unknown,
	after: unknown,
	handle: Handle | undefined,
	capture?: CaptureTables,
): Operation => ({
	do: createAssignMutation(path, after),
	undo: linkUndo(path, before, true, handle, capture),
});

const commitOperation = (context: DiffContext, pair: Operation): void => {
	context.ops.push(pair);
};

const commitLink = (
	context: DiffContext,
	path: OperationPath,
	ref: number,
	before: unknown,
	beforePresent: boolean,
): void => {
	commitOperation(context, linkOperation(path, ref, before, beforePresent, context.handle, context.capture));
};

const emptyContainerOf = (value: object): object => (isPlainArray(value) ? [] : {});

const mintDecomposedContents = (context: DiffContext, path: OperationPath, after: object, residual: ChainSet): void => {
	if (isPlainArray(after)) {
		if (after.length > 0)
			commitOperation(
				context,
				changePair(appendOperationPath(path, "length"), 0, after.length, context.handle, context.capture),
			);

		for (let index = 0; index < after.length; index++) {
			if (!Object.hasOwn(after, index)) continue;

			pushAddition(context, appendOperationPath(path, index), after[index], childChainsOf(residual, index));
		}

		diffObjectProperties(context, [], after, path, true, residual);
	} else {
		for (const entry of walkDataEntries(after)) {
			pushAddition(context, appendOperationPath(path, entry.key), entry.value, childChainsOf(residual, entry.key));
		}
	}
};

const mintDecomposedAddition = (context: DiffContext, path: OperationPath, after: object, residual: ChainSet): void => {
	commitOperation(context, {
		do: createAssignMutation(path, emptyContainerOf(after), after),
		undo: createDeleteMutation(path),
	});
	mintDecomposedContents(context, path, after, residual);
};

const mintDecomposedChange = (
	context: DiffContext,
	path: OperationPath,
	before: unknown,
	after: object,
	residual: ChainSet,
): void => {
	commitOperation(context, {
		do: createAssignMutation(path, emptyContainerOf(after), after),
		undo: linkUndo(path, before, true, context.handle, context.capture),
	});
	mintDecomposedContents(context, path, after, residual);
};

const internLiveSkippingOmissions = (context: DiffContext, handle: Handle, node: object, path: OperationPath): void => {
	if (context.capture.omissions.size === 0) {
		internSubtree(handle, node, undefined, context.capture);

		return;
	}

	const omitted = new Set<object>();
	const visits = new Set<object>();

	const collect = (current: object, currentPath: OperationPath): void => {
		const raw = occupancyNodeOf(current);

		if (visits.has(raw)) return;

		visits.add(raw);

		for (const entry of walkDataEntries(current)) {
			if (typeof entry.value !== "object" || entry.value === null) continue;

			const childPath = appendOperationPath(currentPath, segmentFor(current, entry.key));

			if (isOmittedPath(context, childPath)) {
				omitted.add(occupancyNodeOf(entry.value));

				continue;
			}

			collect(entry.value, childPath);
		}
	};

	collect(node, path);
	internSubtree(handle, node, (_parent, _key, child) => omitted.has(occupancyNodeOf(child)), context.capture);
};

const mintAssignment = (
	context: DiffContext,
	path: OperationPath,
	before: unknown,
	after: unknown,
	beforePresent: boolean,
	residual: ChainSet,
): void => {
	if (isSkippedPath(context, path, residual)) return;

	const handle = context.handle;

	if (isObjectLike(after) && handle !== undefined) {
		const internedId = internedIdOf(handle, after, context.capture);

		if (internedId !== undefined && internedOccupied(handle, after, context.capture)) {
			const sameOccupant = isObjectLike(before) && occupancyNodeOf(before) === occupancyNodeOf(after);
			const beforeInterned = isObjectLike(before) && internedIdOf(handle, before, context.capture) !== undefined;
			const uninternedTrackedBefore =
				isObjectLike(before) && !beforeInterned && admissionLane(before) !== "untracked";

			if (!sameOccupant && !uninternedTrackedBefore) {
				commitLink(context, path, internedId, before, beforePresent);

				return;
			}
		} else if (admissionLane(after) !== "untracked" && (isPlainObject(after) || isPlainArray(after))) {
			stageVend(handle, context.capture, after);

			if (interiorReachesInternedOccupied(handle, after, context.capture)) {
				if (!beforePresent) {
					mintDecomposedAddition(context, path, after, residual);

					return;
				}

				mintDecomposedChange(context, path, before, after, residual);

				return;
			}
		}

		admitDescendants(context, path, new Set(), false, residual);
		internLiveSkippingOmissions(context, handle, after, path);
	} else if (isObjectLike(after)) admitDescendants(context, path, new Set(), false, residual);

	const assigned = withoutOmittedChildren(context, after, path);

	if (beforePresent) commitOperation(context, changePair(path, before, assigned, handle, context.capture));
	else commitOperation(context, additionPair(path, assigned));
};

const markChangedPath = (context: DiffContext, path: OperationPath): void => {
	if (!writesTables(context) || path.length === 0) return;

	const liveParent = liveAtPath(context.handle.proxy.root, path.slice(0, -1));

	if (!isObjectLike(liveParent)) return;

	markDirtyPath(context.dirty, context.handle, path, liveParent);
};

const pushAddition = (context: DiffContext, path: OperationPath, after: unknown, residual: ChainSet): void => {
	const visit = admitEmitPath(context, path, undefined, after, false, residual);

	if (visit === "omit") return;

	if (visit === "skip" && isOmittedPath(context, path)) return;

	if (isIgnoredPath(context, path, residual)) return;

	markChangedPath(context, path);

	mintAssignment(context, path, undefined, after, false, residual);
};

const pushRemoval = (context: DiffContext, path: OperationPath, before: unknown, residual: ChainSet): void => {
	if (isSkippedPath(context, path, residual)) return;

	if (writesTables(context)) markChangedPath(context, path);

	const handle = context.handle;

	if (isObjectLike(before) && handle !== undefined) {
		const id = internedIdOf(handle, before, context.capture);

		if (id !== undefined && internedOccupied(handle, before, context.capture)) {
			commitOperation(context, {
				do: createDeleteMutation(path),
				undo: createLinkMutation(path, id),
			});

			return;
		}
	}

	commitOperation(context, removalPair(path, before));
};

const pushChange = (
	context: DiffContext,
	path: OperationPath,
	before: unknown,
	after: unknown,
	residual: ChainSet,
): void => {
	markChangedPath(context, path);

	mintAssignment(context, path, before, after, true, residual);
};

const hasAncestorPair = (ancestors: Ancestors, before: object, after: object): boolean =>
	ancestors.get(before)?.has(after) ?? false;

const enterAncestorPair = (ancestors: Ancestors, before: object, after: object): void => {
	const afterSet = ancestors.get(before) ?? new Set<object>();

	afterSet.add(after);
	ancestors.set(before, afterSet);
};

const exitAncestorPair = (ancestors: Ancestors, before: object, after: object): void => {
	const afterSet = ancestors.get(before);

	if (afterSet === undefined) throw new MissingAncestorPairError();

	afterSet.delete(after);

	if (afterSet.size === 0) ancestors.delete(before);
};

const sharesStorageIdentity = (before: unknown, after: unknown): boolean =>
	isObjectLike(before) && isObjectLike(after) && isSameIdentity(before, after);

const isOmittedPath = (context: DiffContext, path: OperationPath): boolean => {
	if (context.capture.omissions.size === 0) return false;

	const pathKey = formatOperationPath(path);

	if (context.capture.omissions.has(pathKey)) return true;

	for (const omitted of context.capture.omissions) {
		if (omitted === "/") return true;

		if (pathKey.startsWith(`${omitted}/`)) return true;
	}

	return false;
};

const isIgnoredPath = (context: DiffContext, path: OperationPath, residual: ChainSet): boolean => {
	if (isChainsIgnored(residual)) return true;

	if (context.handle === undefined || path.length === 0) return false;

	const parent = liveAtPath(context.handle.proxy.root, path.slice(0, -1));
	const key = path[path.length - 1];

	return isObjectLike(parent) && key !== undefined && isIgnoredFrontier(context.handle, parent, key);
};

const isSkippedPath = (context: DiffContext, path: OperationPath, residual: ChainSet): boolean => {
	if (isOmittedPath(context, path)) return true;

	if (context.handle === undefined || path.length === 0) return false;

	return isIgnoredPath(context, path, residual);
};

const withoutOmittedChildren = (context: DiffContext, value: unknown, path: OperationPath): unknown => {
	if (!isObjectLike(value) || context.capture.omissions.size === 0) return value;

	let clone: Record<string, unknown> | Array<unknown> | undefined;

	const written = (): Record<string, unknown> | Array<unknown> => {
		if (clone !== undefined) return clone;

		clone = isPlainArray(value) ? value.slice() : { ...(value as Record<string, unknown>) };

		return clone;
	};

	for (const entry of walkDataEntries(value)) {
		const childPath = appendOperationPath(path, entry.key);

		if (isOmittedPath(context, childPath)) {
			const next = written();

			if (Array.isArray(next)) Reflect.deleteProperty(next, Number(entry.key));
			else Reflect.deleteProperty(next, entry.key);

			continue;
		}

		const stripped = withoutOmittedChildren(context, entry.value, childPath);

		if (stripped === entry.value) continue;

		(written() as Record<string, unknown>)[entry.key] = stripped;
	}

	return clone ?? value;
};

const dataEntryValuesOf = (value: object, ignoreArrayIndexes: boolean): Map<string, unknown> => {
	const entries = new Map<string, unknown>();

	for (const entry of walkDataEntries(value)) {
		if (ignoreArrayIndexes && isCanonicalArrayIndexString(entry.key)) continue;

		entries.set(entry.key, entry.value);
	}

	return entries;
};

const diffObjectProperties = (
	context: DiffContext,
	before: Record<string, unknown> | Array<unknown>,
	after: Record<string, unknown> | Array<unknown>,
	path: OperationPath,
	ignoreArrayIndexes: boolean,
	residual: ChainSet,
): void => {
	const beforeEntries = dataEntryValuesOf(before, ignoreArrayIndexes);
	const afterEntries = dataEntryValuesOf(after, ignoreArrayIndexes);
	const keys = new Set<string>([...beforeEntries.keys(), ...afterEntries.keys()]);

	for (const key of keys) {
		const nextPath = appendOperationPath(path, key);
		const childResidual = childChainsOf(residual, key);
		const beforePresent = beforeEntries.has(key);
		const afterPresent = afterEntries.has(key);

		if (beforePresent && afterPresent) {
			diffValue(context, beforeEntries.get(key), afterEntries.get(key), nextPath, childResidual);
		} else if (beforePresent && !Object.hasOwn(after, key)) {
			pushRemoval(context, nextPath, beforeEntries.get(key), childResidual);
		} else if (afterPresent && !Object.hasOwn(before, key)) {
			pushAddition(context, nextPath, afterEntries.get(key), childResidual);
		}
	}
};

const diffArray = (
	context: DiffContext,
	before: Array<unknown>,
	after: Array<unknown>,
	path: OperationPath,
	residual: ChainSet,
): void => {
	const overlap = Math.min(before.length, after.length);

	for (let index = 0; index < overlap; index++) {
		const beforePresent = Object.hasOwn(before, index);
		const afterPresent = Object.hasOwn(after, index);

		if (!beforePresent && !afterPresent) continue;

		const nextPath = appendOperationPath(path, index);
		const childResidual = childChainsOf(residual, index);

		if (!beforePresent) pushAddition(context, nextPath, after[index], childResidual);
		else if (!afterPresent) pushRemoval(context, nextPath, before[index], childResidual);
		else diffValue(context, before[index], after[index], nextPath, childResidual);
	}

	if (after.length > before.length) {
		pushChange(
			context,
			appendOperationPath(path, "length"),
			before.length,
			after.length,
			childChainsOf(residual, "length"),
		);

		for (let index = before.length; index < after.length; index++) {
			if (Object.hasOwn(after, index))
				pushAddition(context, appendOperationPath(path, index), after[index], childChainsOf(residual, index));
		}
	} else if (after.length < before.length) {
		for (let index = after.length; index < before.length; index++) {
			if (Object.hasOwn(before, index))
				pushRemoval(context, appendOperationPath(path, index), before[index], childChainsOf(residual, index));
		}

		pushChange(
			context,
			appendOperationPath(path, "length"),
			before.length,
			after.length,
			childChainsOf(residual, "length"),
		);
	}

	diffObjectProperties(context, before, after, path, true, residual);
};

const walkContainer = (context: DiffContext, before: object, after: object, walk: () => void): void => {
	if (hasAncestorPair(context.ancestors, before, after)) return;

	enterAncestorPair(context.ancestors, before, after);

	try {
		walk();
	} finally {
		exitAncestorPair(context.ancestors, before, after);
	}
};

const diffValue = (
	context: DiffContext,
	before: unknown,
	after: unknown,
	path: OperationPath,
	residual: ChainSet,
): void => {
	const replacing =
		path.length > 0 && isObjectLike(before) && isObjectLike(after) && !sharesStorageIdentity(before, after);

	const visit = admitEmitPath(context, path, before, after, isObjectLike(before) || before !== undefined, residual);

	if (visit === "omit") return;

	if (visit === "skip" || isSkippedPath(context, path, residual)) {
		if (isOmittedPath(context, path) || Object.is(before, after)) return;

		if (isObjectLike(before) && isObjectLike(after) && sharesStorageIdentity(before, after)) return;

		if (isIgnoredPath(context, path, residual)) return;

		markChangedPath(context, path);

		pushChange(context, path, before, after, residual);

		return;
	}

	if (Object.is(before, after)) return;

	if (replacing) {
		markChangedPath(context, path);

		pushChange(context, path, before, after, residual);

		return;
	}

	if (isPlainArray(before) && isPlainArray(after)) {
		walkContainer(context, before, after, () => diffArray(context, before, after, path, residual));

		return;
	}

	if (isPlainObject(before) && isPlainObject(after)) {
		walkContainer(context, before, after, () => diffObjectProperties(context, before, after, path, false, residual));

		return;
	}

	markChangedPath(context, path);

	pushChange(context, path, before, after, residual);
};

const getRootKind = (value: object): RootKind | undefined => {
	if (isPlainArray(value)) return "plainArray";

	if (isPlainObject(value)) return "plainObject";

	return undefined;
};

/**
 * Diffs two plain objects into ops.
 *
 * @param before - Earlier value.
 * @param after - Later value.
 * @returns Ops from before to after.
 */
export function diffObjects(
	before: object,
	after: object,
	handle?: Handle,
	dirty?: DirtyIndex,
	capture?: CaptureTables,
): Array<Operation> {
	const beforeKind = getRootKind(before);
	const afterKind = getRootKind(after);

	if (beforeKind === undefined || beforeKind !== afterKind) throw new IncompatibleObjectRootsError();

	const ops = new Array<Operation>();

	const context: DiffContext = {
		ops,
		ancestors: new Map(),
		handle,
		dirty,
		capture: capture ?? createCaptureTables(),
	};

	diffValue(
		context,
		before,
		after,
		createOperationPath([]),
		handle === undefined ? [undefined] : chainsAtRoot(handle.declarations),
	);

	return ops;
}
