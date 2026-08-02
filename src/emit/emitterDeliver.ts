import type { EmitterRecord, GroupListener, StateListener } from "./emitterRegistry";
import type { Op } from "../ops/operation";

type Delivery =
	| { readonly kind: "group"; readonly deliver: GroupListener }
	| { readonly kind: "own"; readonly deliver: StateListener };

interface PendingDelivery {
	readonly target: object;
	readonly deliveries: ReadonlyArray<Delivery>;
	readonly ops: ReadonlyArray<Op>;
	readonly meta: unknown;
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
				delivery.deliver(pending.target, pending.ops, pending.meta);
			} else {
				delivery.deliver(pending.ops, pending.meta);
			}
		} catch (error) {
			failures.push(error);
		}
	}
};

export const raiseFailures = (failures: ReadonlyArray<unknown>): void => {
	if (failures.length === 0) return;

	if (failures.length > 1) throw new AggregateError(failures, "opshot: listeners failed during delivery");

	throw failures[0];
};

const queuedDeliveries: Array<PendingDelivery> = [];

let isDelivering = false;

export const deliver = (record: EmitterRecord, ops: ReadonlyArray<Op>, meta: unknown): void => {
	const pending: PendingDelivery = { target: record.target, deliveries: collectDeliveries(record), ops, meta };

	if (isDelivering) {
		queuedDeliveries.push(pending);

		return;
	}

	isDelivering = true;

	try {
		const failures: Array<unknown> = [];

		runDelivery(pending, failures);

		while (queuedDeliveries.length > 0) {
			for (const queued of queuedDeliveries.splice(0, queuedDeliveries.length)) runDelivery(queued, failures);
		}

		raiseFailures(failures);
	} finally {
		isDelivering = false;
	}
};
