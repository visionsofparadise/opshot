import { internedIdOf } from "../intern";
import { internedOccupied } from "./internedOccupancy";
import { createAssignMutation, createDeleteMutation, createLinkMutation, type Operation } from "./operation";
import { isObjectLike } from "./predicates";
import type { Handle } from "../handle";
import type { CaptureTables } from "../occupancy";
import type { OperationPath } from "./path";

export const additionPair = (path: OperationPath, after: unknown): Operation => ({
	do: createAssignMutation(path, after),
	undo: createDeleteMutation(path),
});

export const removalPair = (path: OperationPath, before: unknown): Operation => ({
	do: createDeleteMutation(path),
	undo: createAssignMutation(path, before),
});

export const linkUndo = (
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

export const linkOperation = (
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

export const changePair = (
	path: OperationPath,
	before: unknown,
	after: unknown,
	handle: Handle | undefined,
	capture?: CaptureTables,
): Operation => ({
	do: createAssignMutation(path, after),
	undo: linkUndo(path, before, true, handle, capture),
});
