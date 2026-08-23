import { unstable_getInternalStates } from "valtio/vanilla";
import { edgeStatusOf } from "../edges";
import { getRegisteredTarget } from "../identity";
import { internedIdOf } from "../intern";
import type { Handle } from "../handle";
import type { CaptureTables } from "../occupancy";

const { proxyStateMap } = unstable_getInternalStates();

const rawTargetOf = (value: object): object => proxyStateMap.get(value)?.[0] ?? value;

export const liveOf = (node: object): object => getRegisteredTarget(node) ?? node;

export const occupancyNodeOf = (node: object): object => rawTargetOf(liveOf(node));

export const internedOccupied = (handle: Handle, node: object, capture?: CaptureTables): boolean =>
	internedIdOf(handle, node, capture) !== undefined && edgeStatusOf(handle, occupancyNodeOf(node)).occupied;
