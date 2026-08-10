import {
	closeTransaction,
	cyclicFailureRecords,
	deliverPreparedReport,
	failedRecords,
	isTransactionOpen,
	openTransaction,
	prepareTransactionReport,
	releaseTransactionToWindows,
	reportBareDiff,
	restoreDirtyLedgers,
	rollbackTransaction,
} from "./emit/emitterBare";
import { getEmitter } from "./emit/emitterRegistry";

/**
 * Runs changes in one batch and notifies listeners with optional `meta`.
 *
 * Every subscriber covering a written key hears it, at any depth above or below `state`.
 * Listeners run before this returns, and a throwing one never skips another. Called from inside a
 * listener, or from one running while a transaction reports, it returns before its own listeners run.
 * Nesting a `transact` inside another throws. A throwing callback rolls back tracked writes and emits
 * nothing; effects outside tracked state are not undone.
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

	const record = getEmitter(state);

	if (record !== undefined) {
		reportBareDiff(record);
	}

	const transaction = openTransaction();

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
	const cyclicRecords = cyclicFailureRecords(report);

	if (cyclicRecords.size > 0) {
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
}
