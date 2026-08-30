import { getRegisteredTarget } from "../identity";
import { rawTargetOf } from "../valtio/rawTarget";
import type { Handle } from "../handle";

export const liveOf = (node: object): object => getRegisteredTarget(node) ?? node;

export const occupancyNodeOf = (node: object): object => rawTargetOf(liveOf(node));

export const internedOccupied = (handle: Handle, node: object): boolean => {
	const raw = occupancyNodeOf(node);
	const record = handle.nodes.get(raw);

	return record?.id !== undefined && (record.edges.length > 0 || raw === rawTargetOf(handle.proxy.root));
};
