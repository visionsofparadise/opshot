import { isTrackedEdge, isUntrackedEdge } from "../edges";
import { isSameIdentity } from "../identity";
import { internedIdOf, internNode, internSubtree } from "../intern";
import { dataEntryValuesOf, segmentFor, walkDataEntries } from "../utils/dataEntries";
import { admissionLane } from "../valtio/classify";
import { admitDescendants, admitStep, markChangedPath, type StepVerdict } from "./admission";
import { walkContainer, type Ancestors } from "./ancestorPairs";
import { isPlainArray, isPlainObject } from "./cloneValue";
import { internedOccupied, liveOf, occupancyNodeOf } from "./internedOccupancy";
import { additionPair, changePair, linkOperation, removalPair } from "./mintPairs";
import {
	createAssignMutation,
	createDeleteMutation,
	createLinkMutation,
	type Mutation,
	type Operation,
} from "./operation";
import { appendOperationPath, createOperationPath, type OperationPath } from "./path";
import { isCanonicalArrayIndexString, isObjectLike } from "./predicates";
import type { DirtyIndex, Handle } from "../handle";

type RootKind = "plainObject" | "plainArray";

interface DiffContext {
	readonly ops: Array<Operation>;
	readonly ancestors: Ancestors;
	readonly handle: Handle | undefined;
	readonly dirty: DirtyIndex | undefined;
	readonly announced: Set<number>;
	readonly internedThrough: number;
}

const isLinkable = (context: DiffContext, node: object): boolean => {
	const handle = context.handle;

	if (handle === undefined || !internedOccupied(handle, node)) return false;

	const id = internedIdOf(handle, node);

	return id !== undefined && (id <= context.internedThrough || context.announced.has(id));
};

const announceIds = (context: DiffContext, ids: ReadonlyArray<number> | undefined): void => {
	if (ids === undefined) return;

	for (const id of ids) context.announced.add(id);
};

const occupancyUndo = (
	context: DiffContext,
	path: OperationPath,
	before: unknown,
	beforePresent: boolean,
): Mutation => {
	if (!beforePresent) return createDeleteMutation(path);

	if (isObjectLike(before) && context.handle !== undefined && isLinkable(context, before)) {
		const id = internedIdOf(context.handle, before);

		if (id !== undefined) return createLinkMutation(path, id);
	}

	const ids =
		isObjectLike(before) && context.handle !== undefined ? internIdsOfSubtree(context.handle, before) : undefined;

	return createAssignMutation(path, before, before, ids, context.handle);
};

class IncompatibleObjectRootsError extends Error {
	constructor() {
		super("opshot: diffObjects requires compatible supported object roots");
		this.name = "IncompatibleObjectRootsError";
	}
}

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
	commitOperation(context, linkOperation(path, ref, before, beforePresent, context.handle));
	context.announced.add(ref);
};

const emptyContainerOf = (value: object): object => (isPlainArray(value) ? [] : {});

const namedArrayEntriesOf = (value: Array<unknown>): Map<string, unknown> => {
	const named = new Map<string, unknown>();

	for (const key of Object.keys(value)) {
		if (key === "__proto__" || isCanonicalArrayIndexString(key)) continue;

		const descriptor = Reflect.getOwnPropertyDescriptor(value, key);

		if (!descriptor || !("value" in descriptor)) continue;

		named.set(key, descriptor.value);
	}

	return named;
};

const mintDecomposedContents = (
	context: DiffContext,
	path: OperationPath,
	after: object,
	verdict: StepVerdict,
): void => {
	const liveNode = verdict.liveChild;

	if (isPlainArray(after)) {
		if (after.length > 0)
			commitOperation(context, changePair(appendOperationPath(path, "length"), 0, after.length, context.handle));

		for (let index = 0; index < after.length; index++) {
			if (!Object.hasOwn(after, index)) continue;

			const nextPath = appendOperationPath(path, index);
			const childVerdict = admitStep(context.handle, context.dirty, nextPath, liveNode);

			pushAddition(context, nextPath, after[index], childVerdict, liveNode);
		}

		for (const [key, value] of namedArrayEntriesOf(after)) {
			const nextPath = appendOperationPath(path, key);
			const childVerdict = admitStep(context.handle, context.dirty, nextPath, liveNode);

			pushAddition(context, nextPath, value, childVerdict, liveNode);
		}
	} else {
		for (const entry of walkDataEntries(after)) {
			const nextPath = appendOperationPath(path, entry.key);
			const childVerdict = admitStep(context.handle, context.dirty, nextPath, liveNode);

			pushAddition(context, nextPath, entry.value, childVerdict, liveNode);
		}
	}
};

const mintDecomposed = (
	context: DiffContext,
	path: OperationPath,
	after: object,
	verdict: StepVerdict,
	undo: Mutation,
): void => {
	const containerId = context.handle !== undefined ? internedIdOf(context.handle, after) : undefined;
	const ids = containerId === undefined ? undefined : [containerId];

	commitOperation(context, {
		do: createAssignMutation(path, emptyContainerOf(after), after, ids, context.handle),
		undo,
	});
	announceIds(context, ids);
	mintDecomposedContents(context, path, after, verdict);
};

const mintDecomposedAddition = (
	context: DiffContext,
	path: OperationPath,
	after: object,
	verdict: StepVerdict,
): void => {
	mintDecomposed(context, path, after, verdict, createDeleteMutation(path));
};

const mintDecomposedChange = (
	context: DiffContext,
	path: OperationPath,
	before: unknown,
	after: object,
	verdict: StepVerdict,
): void => {
	mintDecomposed(context, path, after, verdict, occupancyUndo(context, path, before, true));
};

const surveyAssignedSubtree = (
	context: DiffContext,
	node: object,
	stopAtInternedOccupied: boolean,
): { readonly reachesInternedOccupied: boolean } => {
	const handle = context.handle;

	if (handle === undefined) return { reachesInternedOccupied: false };

	const visits = new Set<object>();
	const pending = new Array<object>();

	const visit = (current: object): boolean => {
		const raw = occupancyNodeOf(current);

		if (visits.has(raw)) return false;

		visits.add(raw);

		if (admissionLane(current) === "untracked") return false;

		if (stopAtInternedOccupied) {
			if (current !== node) pending.push(current);
		} else internNode(handle, current);

		const source = liveOf(current);

		for (const entry of walkDataEntries(source)) {
			if (typeof entry.value !== "object" || entry.value === null) continue;

			if (!isTrackedEdge(entry)) continue;

			const child = entry.value;

			if (stopAtInternedOccupied && isLinkable(context, child)) return true;

			if (visit(child)) return true;
		}

		return false;
	};

	if (stopAtInternedOccupied) {
		internNode(handle, node);

		const id = internedIdOf(handle, node);

		if (id !== undefined) context.announced.add(id);
	}

	const reachesInternedOccupied = visit(node);

	if (stopAtInternedOccupied && !reachesInternedOccupied) {
		for (const pendingNode of pending) internNode(handle, pendingNode);
	}

	return { reachesInternedOccupied };
};

const internIdsOfSubtree = (handle: Handle, node: object): Array<number> | undefined => {
	const seen = new Set<object>();
	const ids = new Array<number>();

	const walk = (current: object): void => {
		const id = internedIdOf(handle, current);

		if (id !== undefined) ids.push(id);

		const raw = occupancyNodeOf(current);

		if (seen.has(raw)) return;

		seen.add(raw);

		if (admissionLane(liveOf(current)) === "untracked") return;

		for (const entry of walkDataEntries(current)) {
			if (typeof entry.value !== "object" || entry.value === null) continue;

			if (isUntrackedEdge(handle, current, segmentFor(current, entry.key), entry.value)) continue;

			walk(entry.value);
		}
	};

	walk(node);

	return ids.length === 0 ? undefined : ids;
};

const mintAssignment = (
	context: DiffContext,
	path: OperationPath,
	before: unknown,
	after: unknown,
	beforePresent: boolean,
	verdict: StepVerdict,
): void => {
	if (verdict.ignored) return;

	const handle = context.handle;

	if (isObjectLike(after) && handle !== undefined) {
		const internedId = internedIdOf(handle, after);

		if (internedId !== undefined && isLinkable(context, after)) {
			const sameOccupant = isObjectLike(before) && occupancyNodeOf(before) === occupancyNodeOf(after);
			const beforeInterned = isObjectLike(before) && internedIdOf(handle, before) !== undefined;
			const uninternedTrackedBefore =
				isObjectLike(before) && !beforeInterned && admissionLane(before) !== "untracked";

			if (!sameOccupant && !uninternedTrackedBefore) {
				commitLink(context, path, internedId, before, beforePresent);

				return;
			}

			surveyAssignedSubtree(context, after, false);
		} else if (admissionLane(after) !== "untracked" && (isPlainObject(after) || isPlainArray(after))) {
			const { reachesInternedOccupied } = surveyAssignedSubtree(context, after, true);

			if (reachesInternedOccupied) {
				if (!beforePresent) {
					mintDecomposedAddition(context, path, after, verdict);

					return;
				}

				mintDecomposedChange(context, path, before, after, verdict);

				return;
			}
		} else {
			admitDescendants(handle, path, new Set(), verdict.liveChild);
			internSubtree(handle, after, (_parent, entry) => !isTrackedEdge(entry));
		}
	} else if (isObjectLike(after)) admitDescendants(context.handle, path, new Set(), verdict.liveChild);

	const ids = isObjectLike(after) && handle !== undefined ? internIdsOfSubtree(handle, after) : undefined;

	if (beforePresent) {
		commitOperation(context, {
			do: createAssignMutation(path, after, after, ids, handle),
			undo: occupancyUndo(context, path, before, true),
		});
	} else commitOperation(context, additionPair(path, after, ids, handle));

	announceIds(context, ids);
};

const isRecordedBefore = (context: DiffContext, before: unknown): boolean => {
	if (!isObjectLike(before)) return true;

	if (context.handle === undefined) return true;

	return internedIdOf(context.handle, before) !== undefined;
};

const pushAddition = (
	context: DiffContext,
	path: OperationPath,
	after: unknown,
	verdict: StepVerdict,
	liveParent: unknown,
): void => {
	const { visit, ignored } = verdict;

	if (visit === "skip" || ignored) return;

	markChangedPath(context.handle, context.dirty, path, liveParent);

	mintAssignment(context, path, undefined, after, false, verdict);
};

const pushRemoval = (
	context: DiffContext,
	path: OperationPath,
	before: unknown,
	verdict: StepVerdict,
	liveParent: unknown,
): void => {
	if (verdict.ignored) return;

	if (isObjectLike(before) && !isRecordedBefore(context, before)) return;

	markChangedPath(context.handle, context.dirty, path, liveParent);

	const handle = context.handle;

	if (isObjectLike(before) && handle !== undefined) {
		const id = internedIdOf(handle, before);

		if (id !== undefined && isLinkable(context, before)) {
			commitOperation(context, {
				do: createDeleteMutation(path),
				undo: createLinkMutation(path, id),
			});

			return;
		}

		commitOperation(context, removalPair(path, before, internIdsOfSubtree(handle, before), handle));

		return;
	}

	commitOperation(context, removalPair(path, before, undefined, context.handle));
};

const pushChange = (
	context: DiffContext,
	path: OperationPath,
	before: unknown,
	after: unknown,
	verdict: StepVerdict,
	liveParent: unknown,
): void => {
	markChangedPath(context.handle, context.dirty, path, liveParent);

	if (isObjectLike(before) && !isRecordedBefore(context, before)) {
		mintAssignment(context, path, before, after, false, verdict);

		return;
	}

	mintAssignment(context, path, before, after, true, verdict);
};

const sharesStorageIdentity = (before: unknown, after: unknown): boolean =>
	isObjectLike(before) && isObjectLike(after) && isSameIdentity(before, after);

const diffCollectedProperties = (
	context: DiffContext,
	before: object,
	after: object,
	path: OperationPath,
	liveNode: unknown,
	beforeEntries: Map<string, unknown>,
	afterEntries: Map<string, unknown>,
): void => {
	const keys = new Set<string>([...beforeEntries.keys(), ...afterEntries.keys()]);

	for (const key of keys) {
		const beforePresent = beforeEntries.has(key);
		const afterPresent = afterEntries.has(key);

		if (beforePresent && afterPresent) {
			const beforeValue = beforeEntries.get(key);
			const afterValue = afterEntries.get(key);

			if (Object.is(beforeValue, afterValue)) continue;

			diffValue(context, beforeValue, afterValue, appendOperationPath(path, key), liveNode);
		} else if (beforePresent && !Object.hasOwn(after, key)) {
			const nextPath = appendOperationPath(path, key);
			const verdict = admitStep(context.handle, context.dirty, nextPath, liveNode);

			pushRemoval(context, nextPath, beforeEntries.get(key), verdict, liveNode);
		} else if (afterPresent && !Object.hasOwn(before, key)) {
			const nextPath = appendOperationPath(path, key);
			const verdict = admitStep(context.handle, context.dirty, nextPath, liveNode);

			pushAddition(context, nextPath, afterEntries.get(key), verdict, liveNode);
		}
	}
};

const diffObjectProperties = (
	context: DiffContext,
	before: Record<string, unknown>,
	after: Record<string, unknown>,
	path: OperationPath,
	liveNode: unknown,
): void => {
	diffCollectedProperties(context, before, after, path, liveNode, dataEntryValuesOf(before), dataEntryValuesOf(after));
};

const diffArray = (
	context: DiffContext,
	before: Array<unknown>,
	after: Array<unknown>,
	path: OperationPath,
	liveNode: unknown,
): void => {
	const overlap = Math.min(before.length, after.length);

	for (let index = 0; index < overlap; index++) {
		const beforePresent = Object.hasOwn(before, index);
		const afterPresent = Object.hasOwn(after, index);

		if (!beforePresent && !afterPresent) continue;

		if (beforePresent && afterPresent && Object.is(before[index], after[index])) continue;

		const nextPath = appendOperationPath(path, index);

		if (!beforePresent) {
			const verdict = admitStep(context.handle, context.dirty, nextPath, liveNode);

			pushAddition(context, nextPath, after[index], verdict, liveNode);
		} else if (!afterPresent) {
			const verdict = admitStep(context.handle, context.dirty, nextPath, liveNode);

			pushRemoval(context, nextPath, before[index], verdict, liveNode);
		} else diffValue(context, before[index], after[index], nextPath, liveNode);
	}

	if (after.length > before.length) {
		const lengthPath = appendOperationPath(path, "length");
		const lengthVerdict = admitStep(context.handle, context.dirty, lengthPath, liveNode);

		pushChange(context, lengthPath, before.length, after.length, lengthVerdict, liveNode);

		for (let index = before.length; index < after.length; index++) {
			if (!Object.hasOwn(after, index)) continue;

			const nextPath = appendOperationPath(path, index);
			const verdict = admitStep(context.handle, context.dirty, nextPath, liveNode);

			pushAddition(context, nextPath, after[index], verdict, liveNode);
		}
	} else if (after.length < before.length) {
		for (let index = after.length; index < before.length; index++) {
			if (!Object.hasOwn(before, index)) continue;

			const nextPath = appendOperationPath(path, index);
			const verdict = admitStep(context.handle, context.dirty, nextPath, liveNode);

			pushRemoval(context, nextPath, before[index], verdict, liveNode);
		}

		const lengthPath = appendOperationPath(path, "length");
		const lengthVerdict = admitStep(context.handle, context.dirty, lengthPath, liveNode);

		pushChange(context, lengthPath, before.length, after.length, lengthVerdict, liveNode);
	}

	diffCollectedProperties(
		context,
		before,
		after,
		path,
		liveNode,
		namedArrayEntriesOf(before),
		namedArrayEntriesOf(after),
	);
};

const diffValue = (
	context: DiffContext,
	before: unknown,
	after: unknown,
	path: OperationPath,
	liveParent: unknown,
): void => {
	if (Object.is(before, after)) return;

	const sameStorage = sharesStorageIdentity(before, after);
	const replacing = path.length > 0 && isObjectLike(before) && isObjectLike(after) && !sameStorage;
	const verdict = admitStep(context.handle, context.dirty, path, liveParent);
	const { visit, ignored, liveChild } = verdict;

	if (visit === "skip" || ignored) return;

	if (replacing) {
		pushChange(context, path, before, after, verdict, liveParent);

		return;
	}

	if (isPlainArray(before) && isPlainArray(after)) {
		walkContainer(context.ancestors, before, after, () => diffArray(context, before, after, path, liveChild));

		return;
	}

	if (isPlainObject(before) && isPlainObject(after)) {
		walkContainer(context.ancestors, before, after, () =>
			diffObjectProperties(context, before, after, path, liveChild),
		);

		return;
	}

	pushChange(context, path, before, after, verdict, liveParent);
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
export function diffObjects(before: object, after: object, handle?: Handle, dirty?: DirtyIndex): Array<Operation> {
	const beforeKind = getRootKind(before);
	const afterKind = getRootKind(after);

	if (beforeKind === undefined || beforeKind !== afterKind) throw new IncompatibleObjectRootsError();

	const ops = new Array<Operation>();

	const context: DiffContext = {
		ops,
		ancestors: new Map(),
		handle,
		dirty,
		announced: new Set(),
		internedThrough: handle?.internedThrough ?? 0,
	};

	diffValue(context, before, after, createOperationPath([]), handle?.proxy.root);

	return orderMoveOps(ops);
}

const orderMoveOps = (ops: Array<Operation>): Array<Operation> => {
	const linkedRefs = new Set<number>();

	for (const operation of ops) {
		if (operation.do.verb === "link") linkedRefs.add(operation.do.ref);
	}

	if (linkedRefs.size === 0) return ops;

	const delayed = new Array<Operation>();
	const ordered = new Array<Operation>();

	for (const operation of ops) {
		if (operation.do.verb === "delete" && operation.undo.verb === "link" && linkedRefs.has(operation.undo.ref)) {
			delayed.push(operation);

			continue;
		}

		ordered.push(operation);
	}

	for (const operation of delayed) ordered.push(operation);

	return ordered;
};
