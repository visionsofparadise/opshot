import { registerHandle, type Handle } from "./handle";
import { getRegisteredTarget } from "./identity";
import { isIgnored } from "./ignore";
import { internNode, occupancyNodeOf } from "./intern";
import { isObjectLike } from "./ops/predicates";
import { isUnsafeMarked } from "./unsafeTrack";
import { segmentFor, walkDataEntries, type DataEntry } from "./utils/dataEntries";
import { admissionLane } from "./valtio/classify";
import { rawOf, rawTargetOf } from "./valtio/rawTarget";

const occupancyRootOf = (handle: Handle): object => rawTargetOf(handle.proxy.root);

interface InEdge {
	readonly parent: object;
	readonly key: string | number;
}

export interface NodeRecord {
	edges: Array<InEdge>;
	id: number | undefined;
	exempt: boolean;
}

export function addInEdge(handle: Handle, node: object, parent: object, key: string | number): void {
	const rawNode = rawOf(node);
	const rawParent = rawOf(parent);
	let record = handle.nodes.get(rawNode);

	const parentRecord = handle.nodes.get(rawParent);
	const exempt = isUnsafeMarked(rawNode) || parentRecord?.exempt === true;

	if (record === undefined) {
		record = {
			edges: [],
			id: undefined,
			exempt,
		};
		handle.nodes.set(rawNode, record);
	} else if (record.edges.length === 0) record.exempt = exempt;

	internNode(handle, node);

	if (record.edges.some((edge) => rawOf(edge.parent) === rawParent && edge.key === key)) return;

	record.edges.push({ parent: rawParent, key });
	registerHandle(rawNode, handle);
}

export function hasInEdge(handle: Handle, node: object, parent: object, key: string | number): boolean {
	const edges = handle.nodes.get(rawOf(node))?.edges;

	if (edges === undefined) return false;

	const rawParent = rawOf(parent);

	return edges.some((edge) => rawOf(edge.parent) === rawParent && edge.key === key);
}

export function hasOtherRoutes(handle: Handle, node: object, parent: object, key: string | number): boolean {
	const edges = handle.nodes.get(rawOf(node))?.edges;

	if (edges === undefined || edges.length === 0) return false;

	if (edges.length === 1) return !hasInEdge(handle, node, parent, key);

	return true;
}

export function removeInEdge(
	handle: Handle,
	node: object,
	parent: object,
	key: string | number,
	visited?: Set<object>,
): void {
	const rawNode = rawOf(node);
	const rawParent = rawOf(parent);
	const record = handle.nodes.get(rawNode);

	if (record === undefined) return;

	const index = record.edges.findIndex((edge) => rawOf(edge.parent) === rawParent && edge.key === key);

	if (index === -1) return;

	record.edges.splice(index, 1);

	if (rawNode === occupancyRootOf(handle) || record.edges.length > 0) return;

	const cascade = visited ?? new Set<object>();

	if (cascade.has(rawNode)) return;

	cascade.add(rawNode);

	if (record.id !== undefined) handle.byId.delete(record.id);

	for (const entry of walkDataEntries(rawNode)) {
		if (typeof entry.value !== "object" || entry.value === null) continue;

		if (!isTrackedEdge(entry)) continue;

		removeInEdge(handle, entry.value, rawNode, segmentFor(rawNode, entry.key), cascade);
	}
}

export const isTrackedEdge = (entry: DataEntry): boolean => {
	const value = entry.value;
	const target = isObjectLike(value) ? (getRegisteredTarget(value) ?? value) : value;

	if (isObjectLike(target) && isIgnored(target)) return false;

	return entry.writable && admissionLane(target) === "tracked";
};

export const isUntrackedEdge = (
	handle: Handle | undefined,
	parent: object,
	key: string | number,
	value: object,
): boolean => {
	const rawValue = occupancyNodeOf(value);
	const rawParent = occupancyNodeOf(parent);

	if (handle !== undefined) {
		const held = handle.nodes
			.get(rawValue)
			?.edges.some((edge) => rawOf(edge.parent) === rawParent && edge.key === key);

		if (held === true) return false;
	}

	return isIgnored(value) || admissionLane(rawValue) !== "tracked";
};

const seedFrom = (handle: Handle, node: object, visits: Set<object>): void => {
	const raw = rawOf(node);

	if (visits.has(raw)) return;

	visits.add(raw);

	for (const entry of walkDataEntries(raw)) {
		if (!isTrackedEdge(entry)) continue;

		if (typeof entry.value !== "object" || entry.value === null) continue;

		if (isIgnored(entry.value)) continue;

		const key = segmentFor(raw, entry.key);

		addInEdge(handle, entry.value, raw, key);
		seedFrom(handle, entry.value, visits);
	}
};

export function seedInEdges(handle: Handle): void {
	seedFrom(handle, handle.proxy.root, new Set());
}

export function seedInEdgesUnder(handle: Handle, node: object): void {
	seedFrom(handle, node, new Set());
}
