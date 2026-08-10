import {
	closeTransaction,
	isTransactionOpen,
	openTransaction,
	releaseTransactionToWindows,
	reportTransaction,
	settlePendingBare,
} from "./emit/emitterBare";
import { getEmitter } from "./emit/emitterRegistry";

/**
 * Runs changes in one batch and notifies listeners with optional `meta`.
 *
 * Every subscriber covering a written key hears it, at any depth above or below `state`.
 * Listeners run before this returns, and a throwing one never skips another. Called from inside a
 * listener, or from one running while a transaction reports, it returns before its own listeners run.
 * Nesting a `transact` inside another throws.
 *
 * @param state - State to change.
 * @param mutate - Function that writes the state.
 * @param meta - Passed to listeners.
 * @returns Nothing.
 */
export function transact(state: object, mutate: () => void, meta?: unknown): void {
	if (isTransactionOpen()) {
		throw new Error(
			"opshot: transact cannot be nested; a transaction cannot contain another. Mutate inside the callback rather than transacting, run transactions in sequence, or call applyOperations at top level.",
		);
	}

	const record = getEmitter(state);

	if (record !== undefined) {
		settlePendingBare(record);
	}

	const transaction = openTransaction();

	let completed = false;

	try {
		mutate();
		completed = true;
	} finally {
		closeTransaction(transaction);

		if (!completed) releaseTransactionToWindows(transaction);
	}

	reportTransaction(transaction, meta);
}
