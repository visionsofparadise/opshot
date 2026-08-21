import { unstable_getInternalStates } from "valtio/vanilla";
import { getRegisteredTarget } from "./identity";
import { peelReadProxy } from "./peelReadProxy";
import { walkDataEntries } from "./utils/dataEntries";
import { admissionLane } from "./valtio/classify";
import type { Handle } from "./handle";
import type { CaptureTables } from "./occupancy";

const { proxyStateMap, proxyCache } = unstable_getInternalStates();

const rawTargetOf = (value: object): object => proxyStateMap.get(value)?.[0] ?? value;

const occupancyNodeOf = (node: object): object => {
	const peeled = peelReadProxy(node);
	const object = typeof peeled === "object" && peeled !== null ? peeled : node;

	return rawTargetOf(getRegisteredTarget(object) ?? object);
};

const liveOfInterned = (raw: object): object => proxyCache.get(raw) ?? raw;

const departingNodes = new WeakMap<Handle, Set<object>>();

const committedIdOf = (handle: Handle, raw: object): number | undefined => handle.nodes.get(raw)?.id;

const writeId = (handle: Handle, raw: object, id: number): void => {
	const record = handle.nodes.get(raw);

	if (record === undefined) handle.nodes.set(raw, { edges: [], id });
	else record.id = id;

	handle.byId.set(id, raw);
	handle.departedHold.delete(id);
};

/**
 * Interns `node` on `handle`, minting an id on first admission.
 *
 * @param handle - State handle.
 * @param node - Node to intern.
 * @returns The intern id, minted or already assigned.
 */
function internNode(handle: Handle, node: object): number {
	const raw = occupancyNodeOf(node);
	const existing = committedIdOf(handle, raw);

	if (existing !== undefined) return existing;

	for (const [id, held] of handle.departedHold) {
		if (held === raw) {
			writeId(handle, raw, id);

			return id;
		}
	}

	const id = handle.nextInternId;

	handle.nextInternId += 1;
	writeId(handle, raw, id);

	return id;
}

export function internedIdOf(handle: Handle, node: object, capture?: CaptureTables): number | undefined {
	const raw = occupancyNodeOf(node);
	const committed = committedIdOf(handle, raw);

	if (committed !== undefined) return committed;

	if (capture === undefined) return undefined;

	for (const mint of capture.mints) {
		if (mint.node === raw) return mint.id;
	}

	return undefined;
}

export function stageVend(handle: Handle, capture: CaptureTables, node: object): number {
	const raw = occupancyNodeOf(node);
	const committed = committedIdOf(handle, raw);

	if (committed !== undefined) return committed;

	for (const mint of capture.mints) {
		if (mint.node === raw) return mint.id;
	}

	const id = handle.nextInternId + capture.mints.length;

	capture.mints.push({ node: raw, id });

	return id;
}

export function commitVends(handle: Handle, capture: CaptureTables): void {
	if (capture.mints.length === 0) return;

	for (const { node, id } of capture.mints) writeId(handle, node, id);

	const last = capture.mints[capture.mints.length - 1];

	if (last !== undefined) handle.nextInternId = last.id + 1;

	capture.mints.length = 0;
}

export function nodeOfInternedId(handle: Handle, id: number): object | undefined {
	const raw = handle.byId.get(id) ?? handle.departedHold.get(id);

	if (raw === undefined) return undefined;

	return liveOfInterned(raw);
}

const walkTracked = (
	node: object,
	visits: Set<object>,
	visit: (current: object, raw: object) => boolean,
	skip?: (parent: object, key: string, child: object) => boolean,
): void => {
	const walk = (current: object): void => {
		const raw = occupancyNodeOf(current);

		if (visits.has(raw)) return;

		visits.add(raw);

		if (admissionLane(current) === "untracked") return;

		if (!visit(current, raw)) return;

		for (const entry of walkDataEntries(current)) {
			if (typeof entry.value !== "object" || entry.value === null) continue;

			if (skip?.(current, entry.key, entry.value) === true) continue;

			walk(entry.value);
		}
	};

	walk(node);
};

export function internSubtree(
	handle: Handle,
	node: object,
	skip?: (parent: object, key: string, child: object) => boolean,
	capture?: CaptureTables,
): void {
	walkTracked(
		node,
		new Set(),
		(current) => {
			if (capture === undefined) internNode(handle, current);
			else stageVend(handle, capture, current);

			return true;
		},
		skip,
	);
}

export function hasQueuedDepartures(handle: Handle): boolean {
	const queued = departingNodes.get(handle);

	return queued !== undefined && queued.size > 0;
}

export function queueDeparture(handle: Handle, node: object): void {
	const raw = occupancyNodeOf(node);
	let queued = departingNodes.get(handle);

	if (queued === undefined) {
		queued = new Set();
		departingNodes.set(handle, queued);
	}

	queued.add(raw);
}

const parentOfEdge = (parent: object): object => occupancyNodeOf(parent);

const isOccupiedMember = (handle: Handle, node: object): boolean => {
	const root = rawTargetOf(handle.proxy.root);
	const raw = occupancyNodeOf(node);

	if (raw === root) return true;

	const seen = new Set<object>();

	const walk = (current: object): boolean => {
		if (current === root) return true;

		if (seen.has(current)) return false;

		seen.add(current);

		const edges = handle.nodes.get(current)?.edges;

		if (edges === undefined) return false;

		for (const edge of edges) {
			if (walk(parentOfEdge(edge.parent))) return true;
		}

		return false;
	};

	return walk(raw);
};

export function evictDepartedClusters(handle: Handle): ReadonlyMap<object, ReadonlyArray<number>> {
	const departed = new Map<object, ReadonlyArray<number>>();
	const queued = departingNodes.get(handle);

	if (queued === undefined) return departed;

	const root = rawTargetOf(handle.proxy.root);

	for (const node of queued) {
		if (node === root) continue;

		if ((handle.nodes.get(node)?.edges.length ?? 0) > 0) continue;

		const evicted = new Array<number>();

		walkTracked(node, new Set(), (_current, raw) => {
			if (isOccupiedMember(handle, raw)) return false;

			const id = committedIdOf(handle, raw);

			if (id !== undefined) {
				handle.nodes.delete(raw);
				handle.byId.delete(id);
				handle.departedHold.set(id, raw);
				evicted.push(id);
			}

			return true;
		});

		if (evicted.length > 0) departed.set(node, evicted);
	}

	queued.clear();

	return departed;
}

export function sweepDeparted(handle: Handle): void {
	handle.departedHold.clear();
}
