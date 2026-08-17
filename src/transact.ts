import { closeFrame, openFrame, releaseFrameToWindows, reportFrame, settlePendingBare } from "./emit/emitterBare";
import { getEmitter } from "./emit/emitterRegistry";

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

	if (record?.isMutating === true) throw new Error("opshot: nested transact on the same state");

	if (record !== undefined) {
		settlePendingBare(record);

		record.isMutating = true;
	}

	const frame = openFrame(record);

	let completed = false;

	try {
		mutate();
		completed = true;
	} finally {
		if (record !== undefined) record.isMutating = false;

		closeFrame(frame);

		if (!completed) releaseFrameToWindows(frame);
	}

	reportFrame(frame, meta);
}
