import { chainsAtRoot, childChainsOf, type ChainSet } from "../edges";
import { isSameIdentity } from "../identity";
import { internedIdOf, internSubtree, stageVend } from "../intern";
import { createCaptureTables, type CaptureTables } from "../occupancy";
import { dataEntryValuesOf, walkDataEntries } from "../utils/dataEntries";
import { admissionLane } from "../valtio/classify";
import { admitDescendants, admitEmitPath, emitsSkippedOccupancy, isIgnoredPath, markChangedPath } from "./admission";
import { walkContainer, type Ancestors } from "./ancestorPairs";
import { isPlainArray, isPlainObject } from "./cloneValue";
import { interiorReachesInternedOccupied, internedOccupied, occupancyNodeOf } from "./internedOccupancy";
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

const mintAssignment = (
	context: DiffContext,
	path: OperationPath,
	before: unknown,
	after: unknown,
	beforePresent: boolean,
	residual: ChainSet,
): void => {
	if (isIgnoredPath(context.handle, path, residual)) return;

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

		admitDescendants(handle, path, new Set(), residual);
		internSubtree(handle, after, undefined, context.capture);
	} else if (isObjectLike(after)) admitDescendants(context.handle, path, new Set(), residual);

	if (beforePresent) commitOperation(context, changePair(path, before, after, handle, context.capture));
	else commitOperation(context, additionPair(path, after));
};

const pushAddition = (context: DiffContext, path: OperationPath, after: unknown, residual: ChainSet): void => {
	const visit = admitEmitPath(context.handle, context.dirty, path, residual);

	if (visit === "skip") {
		if (isIgnoredPath(context.handle, path, residual) || !emitsSkippedOccupancy(after)) return;
	} else if (isIgnoredPath(context.handle, path, residual)) return;

	markChangedPath(context.handle, context.dirty, path);

	mintAssignment(context, path, undefined, after, false, residual);
};

const pushRemoval = (context: DiffContext, path: OperationPath, before: unknown, residual: ChainSet): void => {
	if (isIgnoredPath(context.handle, path, residual)) return;

	if (writesTables(context)) markChangedPath(context.handle, context.dirty, path);

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
	markChangedPath(context.handle, context.dirty, path);

	mintAssignment(context, path, before, after, true, residual);
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

const diffValue = (
	context: DiffContext,
	before: unknown,
	after: unknown,
	path: OperationPath,
	residual: ChainSet,
): void => {
	const replacing =
		path.length > 0 && isObjectLike(before) && isObjectLike(after) && !sharesStorageIdentity(before, after);

	const visit = admitEmitPath(context.handle, context.dirty, path, residual);

	if (visit === "skip" || isIgnoredPath(context.handle, path, residual)) {
		if (Object.is(before, after)) return;

		if (isObjectLike(before) && isObjectLike(after) && sharesStorageIdentity(before, after)) return;

		if (isIgnoredPath(context.handle, path, residual) || !emitsSkippedOccupancy(after)) return;

		markChangedPath(context.handle, context.dirty, path);

		pushChange(context, path, before, after, residual);

		return;
	}

	if (Object.is(before, after)) return;

	if (replacing) {
		markChangedPath(context.handle, context.dirty, path);

		pushChange(context, path, before, after, residual);

		return;
	}

	if (isPlainArray(before) && isPlainArray(after)) {
		walkContainer(context.ancestors, before, after, () => diffArray(context, before, after, path, residual));

		return;
	}

	if (isPlainObject(before) && isPlainObject(after)) {
		walkContainer(context.ancestors, before, after, () =>
			diffObjectProperties(context, before, after, path, false, residual),
		);

		return;
	}

	markChangedPath(context.handle, context.dirty, path);

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
