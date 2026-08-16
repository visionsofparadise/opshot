import {
	captureTransactionWrites,
	captureWrites,
	deliverCapturedRanges,
	emitCapturedWrites,
	emitWrites,
} from "../emit/emitter";
import { requireHandle } from "../handle";
import { isOccupancyRefusal, occupancyRefusalsOf } from "../occupancy";
import { closeTransaction, isTransactionOpen, openTransaction } from "./nest";
import { rollbackTransaction } from "./rollback";

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

const flattenDeliveryFailures = (error: unknown): Array<unknown> => {
	if (error instanceof AggregateError && error.message === "opshot: listeners failed during delivery") {
		return error.errors;
	}

	return [error];
};

const releaseUncaught = (failures: ReadonlyArray<unknown>): void => {
	if (failures.length === 0) return;

	const error =
		failures.length === 1 ? failures[0] : new AggregateError(failures, "opshot: listeners failed during delivery");

	queueMicrotask(() => {
		throw error;
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

	const listenerFailures = new Array<unknown>();

	const emitCollectingListeners = (emit: () => void): void => {
		const baseline = handle.lastSnapshot;

		try {
			emit();
		} catch (error) {
			if (isOccupancyRefusal(error) || handle.lastSnapshot === baseline) throw error;

			listenerFailures.push(...flattenDeliveryFailures(error));
		}
	};

	const deliverQuietly = (ranges: Parameters<typeof deliverCapturedRanges>[0]): void => {
		try {
			deliverCapturedRanges(ranges);
		} catch (error) {
			listenerFailures.push(...flattenDeliveryFailures(error));
		}
	};

	try {
		const starting = captureWrites(handle);

		if (starting.writeError !== undefined) {
			try {
				emitCapturedWrites(handle, starting);
			} catch (error) {
				if (isOccupancyRefusal(error)) throw error;

				listenerFailures.push(...flattenDeliveryFailures(error));
			}

			if (occupancyRefusalsOf(handle).length > 0) return;
		}

		const previousHeld = handle.isFlushHeld;

		handle.isFlushHeld = true;

		openTransaction();

		let completed = false;
		let mutateError: unknown;

		try {
			mutate();
			completed = true;
		} catch (error) {
			mutateError = error;

			throw error;
		} finally {
			closeTransaction();

			if (!completed) {
				try {
					rollbackTransaction(handle);
				} catch (rollbackError) {
					attachRollbackCause(mutateError, rollbackError);
				}

				handle.isFlushHeld = previousHeld;
				deliverQuietly([starting]);
			} else {
				handle.isFlushHeld = previousHeld;
			}
		}

		let transaction: ReturnType<typeof captureTransactionWrites>;

		try {
			transaction = captureTransactionWrites(handle, meta, channelId);
		} catch (error) {
			try {
				rollbackTransaction(handle);
			} catch (rollbackError) {
				attachRollbackCause(error, rollbackError);
			}

			deliverQuietly([starting]);

			throw error;
		}

		deliverQuietly([starting, transaction]);

		emitCollectingListeners(() => {
			emitWrites(handle);
		});
	} finally {
		releaseUncaught(listenerFailures);
	}
}
