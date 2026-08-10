import type { EmitterRecord, GroupDeliver, StateDeliver } from "./emitterRegistry";
import type { Operation } from "../ops/operation";

type Delivery =
	| { readonly kind: "group"; readonly deliver: GroupDeliver }
	| { readonly kind: "own"; readonly deliver: StateDeliver };

export interface PendingDelivery {
	readonly writeProxy: object;
	readonly deliveries: ReadonlyArray<Delivery>;
	readonly ops: ReadonlyArray<Operation>;
	readonly meta: unknown;
	readonly channelId: object | undefined;
}

const collectDeliveries = (record: EmitterRecord): Array<Delivery> => {
	const deliveries: Array<Delivery> = [];

	for (const groupListeners of record.groupChain ?? []) {
		for (const byChannel of groupListeners.values()) {
			for (const deliverToListener of byChannel.values()) {
				deliveries.push({ kind: "group", deliver: deliverToListener });
			}
		}
	}

	for (const byChannel of record.listeners.values()) {
		for (const deliverToListener of byChannel.values()) {
			deliveries.push({ kind: "own", deliver: deliverToListener });
		}
	}

	return deliveries;
};

const runDelivery = (pending: PendingDelivery, failures: Array<unknown>): void => {
	for (const delivery of pending.deliveries) {
		try {
			if (delivery.kind === "group") {
				delivery.deliver(pending.writeProxy, pending.ops, pending.meta, pending.channelId);
			} else {
				delivery.deliver(pending.ops, pending.meta, pending.channelId);
			}
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
	record: EmitterRecord,
	ops: ReadonlyArray<Operation>,
	meta: unknown,
	channelId: object | undefined,
): PendingDelivery => ({
	writeProxy: record.writeProxy,
	deliveries: collectDeliveries(record),
	ops,
	meta,
	channelId,
});

export const enqueueDelivery = (pending: PendingDelivery): void => {
	queuedDeliveries.push(pending);
};

export const recordDeliveryFailure = (error: unknown): void => {
	deliveryFailures.push(error);
};

export const drainDeliveries = (): void => {
	if (isDraining) return;

	isDraining = true;

	try {
		while (queuedDeliveries.length > 0) {
			for (const queued of queuedDeliveries.splice(0, queuedDeliveries.length)) {
				runDelivery(queued, deliveryFailures);
			}
		}
	} finally {
		isDraining = false;
	}

	const failures = deliveryFailures.splice(0, deliveryFailures.length);

	raiseFailures(failures);
};
