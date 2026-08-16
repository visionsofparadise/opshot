import { snapshot } from "valtio/vanilla";
import { requireObjectSnapshot } from "../emit/requireObjectSnapshot";
import { discardPendingOccupanciesForHandle } from "../occupancy";
import { applyMutations } from "../ops/applyMutations";
import { diffObjects } from "../ops/diff";
import type { Handle } from "../handle";

export const rollbackTransaction = (handle: Handle): void => {
	discardPendingOccupanciesForHandle(handle);

	const restoreTarget = handle.lastSnapshot;
	const operations = diffObjects(
		requireObjectSnapshot(snapshot(handle.proxy.root)),
		requireObjectSnapshot(restoreTarget),
		handle,
	);

	if (operations.length > 0) {
		applyMutations(handle.proxy.root, operations, "do");
	}

	handle.lastSnapshot = restoreTarget;
	handle.hasPendingWrites = false;
};
