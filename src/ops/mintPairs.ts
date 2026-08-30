import { internedIdOf } from "../intern";
import { internedOccupied } from "./internedOccupancy";
import { createAssignMutation, createDeleteMutation, createLinkMutation, type Operation } from "./operation";
import { isObjectLike } from "./predicates";
import type { Handle } from "../handle";
import type { OperationPath } from "./path";

export const additionPair = (
	path: OperationPath,
	after: unknown,
	ids?: ReadonlyArray<number>,
	handle?: Handle,
): Operation => ({
	do: createAssignMutation(path, after, after, ids, handle),
	undo: createDeleteMutation(path),
});

export const removalPair = (
	path: OperationPath,
	before: unknown,
	ids?: ReadonlyArray<number>,
	handle?: Handle,
): Operation => ({
	do: createDeleteMutation(path),
	undo: createAssignMutation(path, before, before, ids, handle),
});

export const linkUndo = (
	path: OperationPath,
	before: unknown,
	beforePresent: boolean,
	handle: Handle | undefined,
): Operation["undo"] => {
	if (!beforePresent) return createDeleteMutation(path);

	if (handle !== undefined && isObjectLike(before) && internedOccupied(handle, before)) {
		const id = internedIdOf(handle, before);

		if (id !== undefined) return createLinkMutation(path, id);
	}

	return createAssignMutation(path, before, before, undefined, handle);
};

export const linkOperation = (
	path: OperationPath,
	ref: number,
	before: unknown,
	beforePresent: boolean,
	handle: Handle | undefined,
): Operation => ({
	do: createLinkMutation(path, ref),
	undo: linkUndo(path, before, beforePresent, handle),
});

export const changePair = (
	path: OperationPath,
	before: unknown,
	after: unknown,
	handle: Handle | undefined,
	ids?: ReadonlyArray<number>,
): Operation => ({
	do: createAssignMutation(path, after, after, ids, handle),
	undo: linkUndo(path, before, true, handle),
});
