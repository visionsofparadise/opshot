import { chainsAtRoot, type ChainSet } from "../edges";
import { isSameIdentity } from "../identity";
import { internedIdOf, internSubtree, stageVend } from "../intern";
import { createCaptureTables, type CaptureTables } from "../occupancy";
import { dataEntryValuesOf, segmentFor, walkDataEntries } from "../utils/dataEntries";
import { admissionLane } from "../valtio/classify";
import { admitDescendants, admitStep, emitsSkippedOccupancy, markChangedPath, type StepVerdict } from "./admission";
import { walkContainer, type Ancestors } from "./ancestorPairs";
import { isPlainArray, isPlainObject } from "./cloneValue";
import { internedOccupied, occupancyNodeOf } from "./internedOccupancy";
import { additionPair, changePair, linkOperation, linkUndo, removalPair } from "./mintPairs";
import { createAssignMutation, createDeleteMutation, createLinkMutation, type Operation } from "./operation";
import { appendOperationPath, createOperationPath, type OperationPath } from "./path";
import { isObjectLike } from "./predicates";
import type { DirtyIndex, Handle } from "../handle";

type RootKind = "plainObject" | "plainArray";

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

const writesTables = (context: DiffContext): context is DiffContext & { handle: Handle; dirty: DirtyIndex } =>
	context.handle !== undefined && context.dirty !== undefined;

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

const mintDecomposedContents = (
	context: DiffContext,
	path: OperationPath,
	after: object,
	verdict: StepVerdict,
): void => {
	const residual = verdict.chains;
	const liveNode = verdict.liveChild;

	if (isPlainArray(after)) {
		if (after.length > 0)
			commitOperation(
				context,
				changePair(appendOperationPath(path, "length"), 0, after.length, context.handle, context.capture),
			);

		for (let index = 0; index < after.length; index++) {
			if (!Object.hasOwn(after, index)) continue;

			const nextPath = appendOperationPath(path, index);
			const childVerdict = admitStep(context.handle, context.dirty, nextPath, liveNode, residual);

			pushAddition(context, nextPath, after[index], childVerdict, liveNode);
		}

		diffObjectProperties(context, [], after, path, true, residual, liveNode);
	} else {
		for (const entry of walkDataEntries(after)) {
			const nextPath = appendOperationPath(path, entry.key);
			const childVerdict = admitStep(context.handle, context.dirty, nextPath, liveNode, residual);

			pushAddition(context, nextPath, entry.value, childVerdict, liveNode);
		}
	}
};

const mintDecomposedAddition = (
	context: DiffContext,
	path: OperationPath,
	after: object,
	verdict: StepVerdict,
): void => {
	commitOperation(context, {
		do: createAssignMutation(path, emptyContainerOf(after), after),
		undo: createDeleteMutation(path),
	});
	mintDecomposedContents(context, path, after, verdict);
};

const mintDecomposedChange = (
	context: DiffContext,
	path: OperationPath,
	before: unknown,
	after: object,
	verdict: StepVerdict,
): void => {
	commitOperation(context, {
		do: createAssignMutation(path, emptyContainerOf(after), after),
		undo: linkUndo(path, before, true, context.handle, context.capture),
	});
	mintDecomposedContents(context, path, after, verdict);
};

const surveyAssignedSubtree = (
	handle: Handle,
	capture: CaptureTables,
	path: OperationPath,
	node: object,
	residual: ChainSet,
	liveNode: unknown,
	stopAtInternedOccupied: boolean,
	dirty: DirtyIndex | undefined,
): { readonly reachesInternedOccupied: boolean } => {
	const visits = new Set<object>();
	const pending = new Array<object>();

	const visit = (
		current: object,
		currentPath: OperationPath,
		currentResidual: ChainSet,
		currentLive: unknown,
	): boolean => {
		const raw = occupancyNodeOf(current);

		if (visits.has(raw)) return false;

		visits.add(raw);

		if (admissionLane(current) === "untracked") return false;

		if (stopAtInternedOccupied) {
			if (current !== node) pending.push(current);
		} else stageVend(handle, capture, current);

		for (const entry of walkDataEntries(current)) {
			if (typeof entry.value !== "object" || entry.value === null) continue;

			const child = entry.value;
			const key = segmentFor(current, entry.key);
			const childPath = appendOperationPath(currentPath, key);

			if (stopAtInternedOccupied && internedOccupied(handle, child, capture)) return true;

			let childResidual = currentResidual;
			let childLive: unknown = undefined;

			if (isObjectLike(currentLive)) {
				const childVerdict = admitStep(handle, dirty, childPath, currentLive, currentResidual);

				childResidual = childVerdict.chains;
				childLive = childVerdict.liveChild;
			}

			if (visit(child, childPath, childResidual, childLive)) return true;
		}

		return false;
	};

	if (stopAtInternedOccupied) stageVend(handle, capture, node);

	const reachesInternedOccupied = visit(node, path, residual, liveNode);

	if (stopAtInternedOccupied && !reachesInternedOccupied) {
		for (const pendingNode of pending) stageVend(handle, capture, pendingNode);
	}

	return { reachesInternedOccupied };
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

			surveyAssignedSubtree(
				handle,
				context.capture,
				path,
				after,
				verdict.chains,
				verdict.liveChild,
				false,
				context.dirty,
			);
		} else if (admissionLane(after) !== "untracked" && (isPlainObject(after) || isPlainArray(after))) {
			const { reachesInternedOccupied } = surveyAssignedSubtree(
				handle,
				context.capture,
				path,
				after,
				verdict.chains,
				verdict.liveChild,
				true,
				context.dirty,
			);

			if (reachesInternedOccupied) {
				if (!beforePresent) {
					mintDecomposedAddition(context, path, after, verdict);

					return;
				}

				mintDecomposedChange(context, path, before, after, verdict);

				return;
			}
		} else {
			admitDescendants(handle, path, new Set(), verdict.chains, verdict.liveChild);
			internSubtree(handle, after, undefined, context.capture);
		}
	} else if (isObjectLike(after)) admitDescendants(context.handle, path, new Set(), verdict.chains, verdict.liveChild);

	if (beforePresent) commitOperation(context, changePair(path, before, after, handle, context.capture));
	else commitOperation(context, additionPair(path, after));
};

const pushAddition = (
	context: DiffContext,
	path: OperationPath,
	after: unknown,
	verdict: StepVerdict,
	liveParent: unknown,
): void => {
	const { visit, ignored } = verdict;

	if (visit === "skip") {
		if (ignored || !emitsSkippedOccupancy(after)) return;
	} else if (ignored) return;

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

	if (writesTables(context)) markChangedPath(context.handle, context.dirty, path, liveParent);

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
	verdict: StepVerdict,
	liveParent: unknown,
): void => {
	markChangedPath(context.handle, context.dirty, path, liveParent);

	mintAssignment(context, path, before, after, true, verdict);
};

const sharesStorageIdentity = (before: unknown, after: unknown): boolean =>
	isObjectLike(before) && isObjectLike(after) && isSameIdentity(before, after);

const diffObjectProperties = (
	context: DiffContext,
	before: Record<string, unknown> | Array<unknown>,
	after: Record<string, unknown> | Array<unknown>,
	path: OperationPath,
	ignoreArrayIndexes: boolean,
	residual: ChainSet,
	liveNode: unknown,
): void => {
	const beforeEntries = dataEntryValuesOf(before, ignoreArrayIndexes);
	const afterEntries = dataEntryValuesOf(after, ignoreArrayIndexes);
	const keys = new Set<string>([...beforeEntries.keys(), ...afterEntries.keys()]);

	for (const key of keys) {
		const nextPath = appendOperationPath(path, key);
		const beforePresent = beforeEntries.has(key);
		const afterPresent = afterEntries.has(key);

		if (beforePresent && afterPresent) {
			diffValue(context, beforeEntries.get(key), afterEntries.get(key), nextPath, residual, liveNode);
		} else if (beforePresent && !Object.hasOwn(after, key)) {
			const verdict = admitStep(context.handle, context.dirty, nextPath, liveNode, residual);

			pushRemoval(context, nextPath, beforeEntries.get(key), verdict, liveNode);
		} else if (afterPresent && !Object.hasOwn(before, key)) {
			const verdict = admitStep(context.handle, context.dirty, nextPath, liveNode, residual);

			pushAddition(context, nextPath, afterEntries.get(key), verdict, liveNode);
		}
	}
};

const diffArray = (
	context: DiffContext,
	before: Array<unknown>,
	after: Array<unknown>,
	path: OperationPath,
	residual: ChainSet,
	liveNode: unknown,
): void => {
	const overlap = Math.min(before.length, after.length);

	for (let index = 0; index < overlap; index++) {
		const beforePresent = Object.hasOwn(before, index);
		const afterPresent = Object.hasOwn(after, index);

		if (!beforePresent && !afterPresent) continue;

		const nextPath = appendOperationPath(path, index);

		if (!beforePresent) {
			const verdict = admitStep(context.handle, context.dirty, nextPath, liveNode, residual);

			pushAddition(context, nextPath, after[index], verdict, liveNode);
		} else if (!afterPresent) {
			const verdict = admitStep(context.handle, context.dirty, nextPath, liveNode, residual);

			pushRemoval(context, nextPath, before[index], verdict, liveNode);
		} else diffValue(context, before[index], after[index], nextPath, residual, liveNode);
	}

	if (after.length > before.length) {
		const lengthPath = appendOperationPath(path, "length");
		const lengthVerdict = admitStep(context.handle, context.dirty, lengthPath, liveNode, residual);

		pushChange(context, lengthPath, before.length, after.length, lengthVerdict, liveNode);

		for (let index = before.length; index < after.length; index++) {
			if (!Object.hasOwn(after, index)) continue;

			const nextPath = appendOperationPath(path, index);
			const verdict = admitStep(context.handle, context.dirty, nextPath, liveNode, residual);

			pushAddition(context, nextPath, after[index], verdict, liveNode);
		}
	} else if (after.length < before.length) {
		for (let index = after.length; index < before.length; index++) {
			if (!Object.hasOwn(before, index)) continue;

			const nextPath = appendOperationPath(path, index);
			const verdict = admitStep(context.handle, context.dirty, nextPath, liveNode, residual);

			pushRemoval(context, nextPath, before[index], verdict, liveNode);
		}

		const lengthPath = appendOperationPath(path, "length");
		const lengthVerdict = admitStep(context.handle, context.dirty, lengthPath, liveNode, residual);

		pushChange(context, lengthPath, before.length, after.length, lengthVerdict, liveNode);
	}

	diffObjectProperties(context, before, after, path, true, residual, liveNode);
};

const diffValue = (
	context: DiffContext,
	before: unknown,
	after: unknown,
	path: OperationPath,
	residual: ChainSet,
	liveParent: unknown,
): void => {
	const replacing =
		path.length > 0 && isObjectLike(before) && isObjectLike(after) && !sharesStorageIdentity(before, after);

	const verdict = admitStep(context.handle, context.dirty, path, liveParent, residual);
	const { visit, ignored, liveChild, chains } = verdict;

	if (visit === "skip" || ignored) {
		if (Object.is(before, after)) return;

		if (isObjectLike(before) && isObjectLike(after) && sharesStorageIdentity(before, after)) return;

		if (ignored || !emitsSkippedOccupancy(after)) return;

		markChangedPath(context.handle, context.dirty, path, liveParent);

		pushChange(context, path, before, after, verdict, liveParent);

		return;
	}

	if (Object.is(before, after)) return;

	if (replacing) {
		markChangedPath(context.handle, context.dirty, path, liveParent);

		pushChange(context, path, before, after, verdict, liveParent);

		return;
	}

	if (isPlainArray(before) && isPlainArray(after)) {
		walkContainer(context.ancestors, before, after, () => diffArray(context, before, after, path, chains, liveChild));

		return;
	}

	if (isPlainObject(before) && isPlainObject(after)) {
		walkContainer(context.ancestors, before, after, () =>
			diffObjectProperties(context, before, after, path, false, chains, liveChild),
		);

		return;
	}

	markChangedPath(context.handle, context.dirty, path, liveParent);

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
		handle?.proxy.root,
	);

	return ops;
}
