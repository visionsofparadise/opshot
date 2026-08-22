import { unstable_getInternalStates } from "valtio/vanilla";
import { getRegisteredTarget } from "./identity";
import { createAssignMutation, createLinkMutation, getValueOriginal, type Operation } from "./ops/operation";
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
	else {
		if (record.id !== undefined && record.id !== id) handle.byId.delete(record.id);

		record.id = id;
	}

	handle.byId.set(id, raw);
};

/**
 * Interns `node` on `handle`, minting an id on first admission. Undo of a departure rebinds via the `ids` override on the assign half, the one carried naming fact.
 *
 * @param handle - State handle.
 * @param node - Node to intern.
 * @returns The intern id, minted or already assigned.
 */
function internNode(handle: Handle, node: object): number {
	const raw = occupancyNodeOf(node);
	const existing = committedIdOf(handle, raw);

	if (existing !== undefined) return existing;

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

/**
 * Stages the next intern id for `node` in capture-walk order. Undo restoration uses the assign-half `ids` override, not this function.
 *
 * @param handle - State handle.
 * @param capture - Capture tables that hold staged mints until commit.
 * @param node - Node to vend an id for.
 * @returns The committed id, a previously staged id, or the next staged id.
 */
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
	const raw = handle.byId.get(id);

	if (raw === undefined) return undefined;

	return liveOfInterned(raw);
}

const walkTracked = (
	node: object,
	visits: Set<object>,
	visit: (current: object, raw: object, parent?: object, key?: string) => boolean,
	skip?: (parent: object, key: string, child: object) => boolean,
): void => {
	const walk = (current: object, parent?: object, key?: string): void => {
		const raw = occupancyNodeOf(current);

		if (visits.has(raw)) return;

		visits.add(raw);

		if (admissionLane(current) === "untracked") return;

		if (!visit(current, raw, parent, key)) return;

		for (const entry of walkDataEntries(current)) {
			if (typeof entry.value !== "object" || entry.value === null) continue;

			if (skip?.(current, entry.key, entry.value) === true) continue;

			walk(entry.value, current, entry.key);
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

const walkUnoccupiedCluster = (
	handle: Handle,
	node: object,
	visit: (raw: object, id: number | undefined) => void,
): void => {
	walkTracked(node, new Set(), (_current, raw) => {
		if (isOccupiedMember(handle, raw)) return false;

		visit(raw, committedIdOf(handle, raw));

		return true;
	});
};

const walkSlots = (
	node: object,
	visit: (current: object, raw: object, parent?: object, key?: string) => boolean,
): void => {
	const visits = new Set<object>();

	const walk = (current: object, parent?: object, key?: string): void => {
		const raw = occupancyNodeOf(current);
		const looping = visits.has(raw);

		if (!looping) visits.add(raw);

		if (admissionLane(current) === "untracked") return;

		if (!visit(current, raw, parent, key) || looping) return;

		for (const entry of walkDataEntries(current)) {
			if (typeof entry.value !== "object" || entry.value === null) continue;

			walk(entry.value, current, entry.key);
		}
	};

	walk(node);
};

export function evictDepartedClusters(handle: Handle): ReadonlyMap<object, ReadonlyArray<number>> {
	const departed = new Map<object, ReadonlyArray<number>>();
	const queued = departingNodes.get(handle);

	if (queued === undefined) return departed;

	const ungrounded = new Array<object>();

	for (const node of queued) {
		if (!isOccupiedMember(handle, node)) ungrounded.push(node);
	}

	queued.clear();

	for (const node of ungrounded) {
		const clusterIds = new Array<number>();

		walkSlots(node, (_current, raw) => {
			const id = committedIdOf(handle, raw);

			if (id !== undefined) clusterIds.push(id);

			return !isOccupiedMember(handle, raw);
		});

		walkUnoccupiedCluster(handle, node, (raw, id) => {
			if (id !== undefined) {
				handle.nodes.delete(raw);
				handle.byId.delete(id);
			} else handle.nodes.delete(raw);
		});

		if (clusterIds.length > 0) departed.set(node, clusterIds);
	}

	return departed;
}

export function bindVendedIds(
	handle: Handle,
	node: object,
	ids: ReadonlyArray<number>,
	parent?: object,
	key?: PropertyKey,
): void {
	let index = 0;

	walkSlots(node, (_current, raw, walkParent, walkKey) => {
		const id = ids[index];

		if (id === undefined) return true;

		index += 1;

		const held = handle.byId.get(id);
		const slotParent = walkParent ?? parent;
		const slotKey: PropertyKey | undefined = walkKey ?? key;

		if (held !== undefined) {
			if (occupancyNodeOf(held) !== raw && slotParent !== undefined && slotKey !== undefined) {
				Reflect.set(slotParent, slotKey, liveOfInterned(held));
			}

			return false;
		}

		writeId(handle, raw, id);

		if (id >= handle.nextInternId) handle.nextInternId = id + 1;

		return true;
	});
}

export function rewindAdmission(handle: Handle, node: object): ReadonlyArray<number> {
	const ids = new Array<number>();

	walkUnoccupiedCluster(handle, node, (raw, id) => {
		if (id === undefined) return;

		ids.push(id);

		const record = handle.nodes.get(raw);

		if (record !== undefined) record.id = undefined;

		handle.byId.delete(id);
	});

	return ids;
}

export function annotateDepartureUndos(
	ops: Array<Operation>,
	departed: ReadonlyMap<object, ReadonlyArray<number>>,
): void {
	for (const [node, ids] of departed) {
		const restoredId = ids[0];

		if (restoredId === undefined) continue;

		const removals = new Array<Operation>();

		for (const operation of ops) {
			if (operation.undo.verb !== "assign") continue;

			const original = getValueOriginal(operation.undo) ?? operation.undo.value;

			if (typeof original !== "object" || original === null) continue;

			if (occupancyNodeOf(original) === node) removals.push(operation);
		}

		const last = removals[removals.length - 1];

		if (last?.undo.verb !== "assign") continue;

		const lastUndo = last.undo;

		(last as { undo: Operation["undo"] }).undo = createAssignMutation(
			lastUndo.path,
			lastUndo.value,
			getValueOriginal(lastUndo) ?? lastUndo.value,
			ids,
		);

		for (const earlier of removals.slice(0, -1)) {
			(earlier as { undo: Operation["undo"] }).undo = createLinkMutation(earlier.undo.path, restoredId);
		}
	}
}
