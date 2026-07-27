import type { EmitterRecord } from "./emitterRegistry";
import type { Op } from "../ops/operation";

export const deliver = (record: EmitterRecord, ops: ReadonlyArray<Op>, meta: unknown): void => {
	const groupDelivers = [...(record.groupListeners?.values() ?? [])].flatMap((byChannel) => [...byChannel.values()]);

	for (const deliverToListener of groupDelivers) deliverToListener(record.target, ops, meta);

	const ownDelivers = [...record.listeners.values()].flatMap((byChannel) => [...byChannel.values()]);

	for (const deliverToListener of ownDelivers) deliverToListener(ops, meta);
};
