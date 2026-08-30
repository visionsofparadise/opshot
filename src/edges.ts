import { unstable_getInternalStates } from "valtio/vanilla";
import { registerHandle, type Handle } from "./handle";
import { getRegisteredTarget } from "./identity";
import { isIgnored } from "./ignore";
import { queueDeparture } from "./intern";
import { isObjectLike } from "./ops/predicates";
import { peelReadProxy } from "./peelReadProxy";
import { isUnsafeMarked } from "./unsafeTrack";
import { segmentFor, walkDataEntries, type DataEntry } from "./utils/dataEntries";
import { admissionLane } from "./valtio/classify";

const { proxyStateMap } = unstable_getInternalStates();

const rawTargetOf = (value: object): object => proxyStateMap.get(value)?.[0] ?? value;

const rawOf = (node: object): object => {
	const peeled = peelReadProxy(node);

	return rawTargetOf(typeof peeled === "object" && peeled !== null ? peeled : node);
};

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

const edgesOf = (handle: Handle, node: object): Array<InEdge> | undefined => handle.nodes.get(node)?.edges;

const walkGroundedChains = (
	handle: Handle,
	node: object,
	onGround: (pathFromRoot: ReadonlyArray<string | number>) => boolean,
): void => {
	const root = occupancyRootOf(handle);

	const walk = (current: object, reverseKeys: ReadonlyArray<string | number>, pathVisited: Set<object>): boolean => {
		if (current === root) return onGround([...reverseKeys].reverse());

		if (pathVisited.has(current)) return false;

		pathVisited.add(current);

		const edges = edgesOf(handle, current);

		if (edges !== undefined) {
			for (const edge of edges) {
				if (walk(rawOf(edge.parent), [...reverseKeys, edge.key], pathVisited)) {
					pathVisited.delete(current);

					return true;
				}
			}
		}

		pathVisited.delete(current);

		return false;
	};

	walk(rawOf(node), [], new Set());
};

export function addInEdge(handle: Handle, node: object, parent: object, key: string | number): void {
	const rawNode = rawOf(node);
	const rawParent = rawOf(parent);
	let record = handle.nodes.get(rawNode);

	if (record === undefined) {
		const parentRecord = handle.nodes.get(rawParent);

		record = {
			edges: [],
			id: undefined,
			exempt: isUnsafeMarked(rawNode) || parentRecord?.exempt === true,
		};
		handle.nodes.set(rawNode, record);
	}

	if (record.edges.some((edge) => rawOf(edge.parent) === rawParent && edge.key === key)) return;

	record.edges.push({ parent: rawParent, key });
	registerHandle(rawNode, handle);
}

export function hasOtherRoutes(handle: Handle, node: object, parent: object, key: string | number): boolean {
	const edges = handle.nodes.get(rawOf(node))?.edges;

	if (edges === undefined) return false;

	const rawParent = rawOf(parent);

	return edges.some((edge) => rawOf(edge.parent) !== rawParent || edge.key !== key);
}

export function removeInEdge(handle: Handle, node: object, parent: object, key: string | number): void {
	const rawNode = rawOf(node);
	const rawParent = rawOf(parent);
	const record = handle.nodes.get(rawNode);

	if (record === undefined) return;

	const index = record.edges.findIndex((edge) => rawOf(edge.parent) === rawParent && edge.key === key);

	if (index === -1) return;

	record.edges.splice(index, 1);

	if (rawNode !== occupancyRootOf(handle)) queueDeparture(handle, rawNode);
}

export function edgeStatusOf(handle: Handle, node: object): { occupied: boolean } {
	const rawNode = rawOf(node);
	const root = occupancyRootOf(handle);

	if (rawNode === root) return { occupied: true };

	let occupied = false;

	walkGroundedChains(handle, rawNode, () => {
		occupied = true;

		return true;
	});

	return { occupied };
}

export const isTrackedEdge = (entry: DataEntry): boolean => {
	const value = entry.value;
	const target = isObjectLike(value) ? (getRegisteredTarget(value) ?? value) : value;

	if (isObjectLike(target) && isIgnored(target)) return false;

	return entry.writable && admissionLane(target) === "tracked";
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
