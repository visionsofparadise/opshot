import type { EmitterRecord, GroupListener, StateListener } from "./emitterRegistry";
import type { Op } from "../ops/operation";

type Delivery =
	| { readonly kind: "group"; readonly deliver: GroupListener }
	| { readonly kind: "own"; readonly deliver: StateListener };

export const deliver = (record: EmitterRecord, ops: ReadonlyArray<Op>, meta: unknown): void => {
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

	for (const delivery of deliveries) {
		if (delivery.kind === "group") {
			delivery.deliver(record.target, ops, meta);
		} else {
			delivery.deliver(ops, meta);
		}
	}
};
