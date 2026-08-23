import { unstable_getInternalStates } from "valtio/vanilla";
import { edgeStatusOf } from "../edges";
import { getRegisteredTarget } from "../identity";
import { internedIdOf } from "../intern";
import { walkDataEntries } from "../utils/dataEntries";
import type { Handle } from "../handle";
import type { CaptureTables } from "../occupancy";

const { proxyStateMap } = unstable_getInternalStates();

const rawTargetOf = (value: object): object => proxyStateMap.get(value)?.[0] ?? value;

export const liveOf = (node: object): object => getRegisteredTarget(node) ?? node;

export const occupancyNodeOf = (node: object): object => rawTargetOf(liveOf(node));

export const internedOccupied = (handle: Handle, node: object, capture?: CaptureTables): boolean =>
	internedIdOf(handle, node, capture) !== undefined && edgeStatusOf(handle, occupancyNodeOf(node)).occupied;

export const interiorReachesInternedOccupied = (handle: Handle, node: object, capture?: CaptureTables): boolean => {
	const seen = new Set<object>();

	const visit = (current: object): boolean => {
		const raw = occupancyNodeOf(current);

		if (seen.has(raw)) return false;

		seen.add(raw);

		for (const entry of walkDataEntries(current)) {
			if (typeof entry.value !== "object" || entry.value === null) continue;

			if (internedOccupied(handle, entry.value, capture)) return true;

			if (visit(entry.value)) return true;
		}

		return false;
	};

	return visit(node);
};
