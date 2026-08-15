import {
	closeTransaction,
	deliverPreparedReport,
	failedRecords,
	flushPendingWritesOfState,
	isTransactionOpen,
	openTransaction,
	prepareTransactionReport,
	releaseTransactionToWindows,
	restoreDirtyLedgers,
	rollbackTransaction,
} from "./emit/emitterBare";

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

	flushPendingWritesOfState(state);

	const transaction = openTransaction(state);

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

			releaseTransactionToWindows(transaction);
		}
	}

	const report = prepareTransactionReport(transaction, meta, channelId);

	if (report.failures.length > 0) {
		const [soleFailure, ...otherFailures] = report.failures;
		const raised: unknown =
			soleFailure !== undefined && otherFailures.length === 0
				? soleFailure.error
				: new AggregateError(
						report.failures.map((failure) => failure.error),
						"opshot: failures during reporting",
					);

		try {
			rollbackTransaction(transaction);
		} catch (rollbackError) {
			attachRollbackCause(raised, rollbackError);
		}

		restoreDirtyLedgers(transaction);
		releaseTransactionToWindows(transaction, failedRecords(report));

		throw raised;
	}

	deliverPreparedReport(report);
	flushPendingWritesOfState(state);
}
