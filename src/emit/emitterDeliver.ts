import type { DirtyIndex, Handle } from "../handle";
import type { Operation } from "../operation";
import type { StateDeliver } from "./emitterRegistry";

export interface PendingDelivery {
	readonly deliveries: ReadonlyArray<StateDeliver>;
	readonly operations: ReadonlyArray<Operation>;
	readonly handle: Handle;
	readonly dirty: DirtyIndex;
}

const runDelivery = (pending: PendingDelivery, failures: Array<unknown>): void => {
	pending.handle.lastDirty = pending.dirty;

	for (const deliver of pending.deliveries) {
		try {
			deliver(pending.operations);
		} catch (error) {
			failures.push(error);
		}
	}
};

const raiseFailures = (failures: ReadonlyArray<unknown>): void => {
	if (failures.length === 0) return;

	if (failures.length > 1) throw new AggregateError(failures, "opshot: listeners failed during delivery");

	throw failures[0];
};

const queuedDeliveries: Array<PendingDelivery> = [];
const deliveryFailures: Array<unknown> = [];

let isDraining = false;

export const prepareDelivery = (
	handle: Handle,
	operations: ReadonlyArray<Operation>,
	dirty: DirtyIndex,
): PendingDelivery => ({
	deliveries: [...handle.subscribers.values()],
	operations,
	handle,
	dirty,
});

export const enqueueDelivery = (pending: PendingDelivery): void => {
	queuedDeliveries.push(pending);
};

export const drainDeliveries = (): void => {
	if (isDraining) return;

	isDraining = true;

	let failures: Array<unknown> = [];

	try {
		while (queuedDeliveries.length > 0) {
			for (const queued of queuedDeliveries.splice(0, queuedDeliveries.length)) {
				runDelivery(queued, deliveryFailures);
			}
		}
	} finally {
		isDraining = false;
		failures = deliveryFailures.splice(0, deliveryFailures.length);
	}

	raiseFailures(failures);
};
