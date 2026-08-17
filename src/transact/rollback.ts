import { snapshot } from "valtio/vanilla";
import { discardPendingOccupanciesForHandle } from "../occupancy";
import { applyMutations } from "../ops/applyMutations";
import { diffObjects } from "../ops/diff";
import type { Handle } from "../handle";

export const rollbackTransaction = (handle: Handle): void => {
	discardPendingOccupanciesForHandle(handle);

	const restoreTarget = handle.lastSnapshot;
	const operations = diffObjects(snapshot(handle.proxy.root), restoreTarget, handle);

	if (operations.length > 0) {
		applyMutations(handle.proxy.root, operations, "do", "restore");
	}

	handle.lastSnapshot = restoreTarget;
	handle.hasPendingWrites = false;
};
