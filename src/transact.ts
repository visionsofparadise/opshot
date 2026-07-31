import { snapshot } from "valtio/vanilla";
import { requireObjectSnapshot, settlePendingBare } from "./emit/emitterBare";
import { deliver } from "./emit/emitterDeliver";
import { getEmitter, hasListeners } from "./emit/emitterRegistry";
import { diffSnapshots } from "./ops/diff";

/**
 * Runs changes in one batch and notifies listeners with optional `meta`.
 *
 * @param state - State to change.
 * @param mutate - Function that writes the state.
 * @param meta - Passed to listeners.
 * @returns Nothing.
 */
export function transact(state: object, mutate: () => void, meta?: unknown): void {
	const record = getEmitter(state);

	if (record === undefined) {
		mutate();

		return;
	}

	if (record.isMutating) throw new Error("opshot: nested transact on the same state");

	settlePendingBare(record);

	record.isMutating = true;

	try {
		mutate();
	} finally {
		record.isMutating = false;
	}

	const after = snapshot(record.target);
	const before = record.lastReported;

	record.lastReported = after;

	if (before === after) return;

	if (!hasListeners(record)) return;

	const ops = diffSnapshots(requireObjectSnapshot(before), requireObjectSnapshot(after));

	if (ops.length === 0) return;

	deliver(record, ops, meta);
}
