import { closeFrame, openFrame, releaseFrameToWindows, reportFrame, settlePendingBare } from "./emit/emitterBare";
import { getEmitter } from "./emit/emitterRegistry";

/**
 * Runs changes in one batch and notifies listeners with optional `meta`.
 *
 * Every subscriber covering a written key hears it, at any depth above or below `state`.
 * Listeners run before this returns, and a throwing one never skips another.
 * Nesting a `transact` inside another delivers the inner one's `meta` only to its own node.
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
