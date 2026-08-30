import { captureBatchWrites, deliverCapturedRanges, emitWrites, type CapturedRange } from "./emit/emitter";
import type { Handle } from "./handle";

export interface BatchFrame {
	readonly meta: unknown;
	readonly written: Set<Handle>;
}

const frameStack: Array<BatchFrame> = [];

let pendingDeliveryFailures: Array<unknown> | undefined;

export function currentBatchFrame(): BatchFrame | undefined {
	return frameStack[frameStack.length - 1];
}

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

const collectListenerFailure = (error: unknown): void => {
	if (pendingDeliveryFailures === undefined) throw error;

	pendingDeliveryFailures.push(...flattenDeliveryFailures(error));
};

const restorePendingOwner = (handle: Handle, enclosing: BatchFrame | undefined): void => {
	handle.pendingOwner = enclosing?.written.has(handle) === true ? enclosing : undefined;

	if (handle.pendingOwner === undefined) handle.isFlushHeld = false;
};

export function prepareBatchWrite(handle: Handle): (() => void) | undefined {
	const frame = currentBatchFrame();

	if (frame === undefined) return undefined;

	const owner = handle.pendingOwner;

	if (owner !== frame) {
		handle.flushGeneration += 1;
		handle.isFlushScheduled = false;

		try {
			if (owner === undefined) emitWrites(handle);
			else deliverCapturedRanges([captureBatchWrites(handle, owner.meta)]);
		} catch (error) {
			collectListenerFailure(error);
		}
	}

	const previousHeld = handle.isFlushHeld;

	handle.isFlushHeld = true;

	return () => {
		if (handle.pendingOwner === frame) return;

		handle.isFlushHeld = previousHeld;
	};
}

export function commitBatchWrite(handle: Handle): void {
	const frame = currentBatchFrame();

	if (frame === undefined) return;

	handle.pendingOwner = frame;
	handle.isFlushHeld = true;
	frame.written.add(handle);
}

/**
 * Runs writes in one batch and notifies listeners with optional `meta`.
 *
 * @param callback - Function that writes any states.
 * @param meta - Passed to listeners.
 * @returns Nothing.
 */
export function batch(callback: () => void, meta?: unknown): void {
	const frame: BatchFrame = { meta, written: new Set() };
	const listenerFailures = new Array<unknown>();
	const previousFailures = pendingDeliveryFailures;

	pendingDeliveryFailures = listenerFailures;
	frameStack.push(frame);

	let didThrow = false;
	let callbackError: unknown;

	try {
		try {
			callback();
		} catch (error) {
			didThrow = true;
			callbackError = error;
		}

		frameStack.pop();

		const enclosing = currentBatchFrame();
		const ranges = new Array<CapturedRange>();

		try {
			for (const handle of frame.written) {
				try {
					ranges.push(captureBatchWrites(handle, frame.meta));
				} catch (error) {
					if (didThrow) listenerFailures.push(...flattenDeliveryFailures(error));
					else throw error;
				} finally {
					restorePendingOwner(handle, enclosing);
				}
			}
		} finally {
			for (const handle of frame.written) restorePendingOwner(handle, enclosing);
		}

		try {
			deliverCapturedRanges(ranges);
		} catch (error) {
			listenerFailures.push(...flattenDeliveryFailures(error));
		}
	} finally {
		if (frameStack[frameStack.length - 1] === frame) frameStack.pop();

		pendingDeliveryFailures = previousFailures;
		releaseUncaught(listenerFailures);
	}

	if (didThrow) throw callbackError;
}
