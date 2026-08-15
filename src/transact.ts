import {
	closeTransaction,
	emitTransactionWrites,
	emitWrites,
	isTransactionOpen,
	openTransaction,
	releaseHold,
	rollbackTransaction,
} from "./emit/emitterBare";
import { requireHandle } from "./handle";

/**
 * Runs changes in one batch and notifies listeners with optional `meta`.
 *
 * @param state - State to change.
 * @param mutate - Function that writes the state.
 * @param meta - Passed to listeners.
 * @returns Nothing.
 */
export function transact(state: object, mutate: () => void, meta?: unknown): void {
	runTransaction(state, mutate, meta, undefined);
}

const attachRollbackCause = (error: unknown, rollbackError: unknown): void => {
	if (!(error instanceof Error) || error.cause !== undefined) return;

	Object.defineProperty(error, "cause", {
		value: rollbackError,
		writable: true,
		enumerable: false,
		configurable: true,
	});
};

export function runTransaction(state: object, mutate: () => void, meta: unknown, channelId: object | undefined): void {
	if (isTransactionOpen()) {
		throw new Error(
			"opshot: transact cannot be nested; a transaction cannot contain another. Mutate inside the callback rather than transacting, run transactions in sequence, or call applyOperations at top level.",
		);
	}

	const handle = requireHandle(state, "opshot: transact requires a state");

	handle.flushGeneration += 1;
	handle.isFlushScheduled = false;

	const ownsHold = !handle.isFlushHeld;

	handle.isFlushHeld = true;

	try {
		emitWrites(handle);

		const transaction = openTransaction(handle);

		let completed = false;
		let mutateError: unknown;

		try {
			mutate();
			completed = true;
		} catch (error) {
			mutateError = error;

			throw error;
		} finally {
			closeTransaction(transaction);

			if (!completed) {
				try {
					rollbackTransaction(transaction);
				} catch (rollbackError) {
					attachRollbackCause(mutateError, rollbackError);
				}
			}
		}

		const restoreTarget = handle.lastSnapshot;

		try {
			emitTransactionWrites(handle, meta, channelId);
		} catch (error) {
			if (handle.lastSnapshot === restoreTarget) {
				try {
					rollbackTransaction(transaction);
				} catch (rollbackError) {
					attachRollbackCause(error, rollbackError);
				}
			}

			throw error;
		}

		emitWrites(handle);
	} finally {
		releaseHold(handle, ownsHold);
	}
}
