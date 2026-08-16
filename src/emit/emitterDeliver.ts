import type { GroupDeliver, StateDeliver } from "./emitterRegistry";
import type { DirtyIndex, Handle } from "../handle";
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
	readonly dirty: DirtyIndex;
}

const collectDeliveries = (handle: Handle): Array<Delivery> => {
	const deliveries: Array<Delivery> = [];

	for (const groupListeners of handle.groups ?? []) {
		for (const byChannel of groupListeners.values()) {
			for (const deliverToListener of byChannel.values()) {
				deliveries.push({ kind: "group", deliver: deliverToListener });
			}
		}
	}

	for (const byChannel of handle.subscribers.values()) {
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
	handle: Handle,
	ops: ReadonlyArray<Operation>,
	meta: unknown,
	channelId: object | undefined,
	dirty: DirtyIndex,
): PendingDelivery => ({
	writeProxy: handle.proxy.root,
	deliveries: collectDeliveries(handle),
	ops,
	meta,
	channelId,
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
