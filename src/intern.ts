import { unstable_getInternalStates } from "valtio/vanilla";
import { getRegisteredTarget } from "./identity";
import { createAssignMutation, createLinkMutation, getValueOriginal, type Operation } from "./ops/operation";
import { peelReadProxy } from "./peelReadProxy";
import { segmentFor, walkDataEntries, type DataEntry } from "./utils/dataEntries";
import { admissionLane } from "./valtio/classify";
import type { ChainSet } from "./edges";
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

const stagedBindIdOf = (capture: CaptureTables, raw: object): number | undefined => capture.bindIdByNode.get(raw);

const stagedMintIdOf = (capture: CaptureTables, raw: object): number | undefined => capture.mintIdByNode.get(raw);

const stagedNodeOf = (capture: CaptureTables, id: number): object | undefined =>
	capture.bindNodeById.get(id) ?? capture.mintNodeById.get(id);

const nextStagedIdOf = (handle: Handle, capture: CaptureTables): number =>
	Math.max(handle.nextInternId, capture.nextStagedId);

const stageMint = (capture: CaptureTables, raw: object, id: number): void => {
	capture.mints.push({ node: raw, id });
	capture.mintIdByNode.set(raw, id);
	capture.mintNodeById.set(id, raw);

	if (id + 1 > capture.nextStagedId) capture.nextStagedId = id + 1;
};

const stageBind = (capture: CaptureTables, raw: object, id: number): void => {
	capture.binds.push({ node: raw, id });
	capture.bindIdByNode.set(raw, id);
	capture.bindNodeById.set(id, raw);

	if (id + 1 > capture.nextStagedId) capture.nextStagedId = id + 1;
};

const namedRawOf = (handle: Handle, id: number, capture?: CaptureTables): object | undefined => {
	const staged = capture === undefined ? undefined : stagedNodeOf(capture, id);

	return staged ?? handle.byId.get(id);
};

export function internedIdOf(handle: Handle, node: object, capture?: CaptureTables): number | undefined {
	const raw = occupancyNodeOf(node);
	const bound = capture === undefined ? undefined : stagedBindIdOf(capture, raw);

	if (bound !== undefined) return bound;

	const committed = committedIdOf(handle, raw);

	if (committed !== undefined) return committed;

	if (capture === undefined) return undefined;

	return stagedMintIdOf(capture, raw);
}

/**
 * Stages the next intern id for `node` in capture-walk order. Undo restoration uses the assign-half `ids` override, not this function.
 *
 * @param handle - State handle.
 * @param capture - Capture tables that hold staged names until commit.
 * @param node - Node to vend an id for.
 * @returns The committed id, a previously staged id, or the next staged id.
 */
export function stageVend(handle: Handle, capture: CaptureTables, node: object): number {
	const raw = occupancyNodeOf(node);
	const bound = stagedBindIdOf(capture, raw);

	if (bound !== undefined) return bound;

	const committed = committedIdOf(handle, raw);

	if (committed !== undefined) return committed;

	const staged = stagedMintIdOf(capture, raw);

	if (staged !== undefined) return staged;

	const id = nextStagedIdOf(handle, capture);

	stageMint(capture, raw, id);

	return id;
}

const commitName = (handle: Handle, raw: object, id: number): void => {
	writeId(handle, raw, id);

	if (id >= handle.nextInternId) handle.nextInternId = id + 1;
};

export function commitVends(handle: Handle, capture: CaptureTables): void {
	for (const { node, id } of capture.mints) commitName(handle, node, id);

	capture.mints.length = 0;

	for (const { node, id } of capture.binds) commitName(handle, node, id);

	capture.binds.length = 0;
	capture.bindIdByNode.clear();
	capture.bindNodeById.clear();
	capture.mintIdByNode.clear();
	capture.mintNodeById.clear();
	capture.nextStagedId = 0;
}

export function nodeOfInternedId(handle: Handle, id: number, capture?: CaptureTables): object | undefined {
	const raw = namedRawOf(handle, id, capture);

	if (raw === undefined) return undefined;

	return liveOfInterned(raw);
}

export type ChildChainResolver = (
	parent: object,
	parentChains: ChainSet,
	key: string | number,
	entry: DataEntry,
) => ChainSet | undefined;

const walkTracked = (
	node: object,
	visits: Set<object>,
	chains: ChainSet | undefined,
	resolve: ChildChainResolver | undefined,
	visit: (current: object, raw: object, parent?: object, key?: string) => boolean,
): void => {
	const walk = (current: object, currentChains: ChainSet | undefined, parent?: object, key?: string): void => {
		const raw = occupancyNodeOf(current);

		if (visits.has(raw)) return;

		visits.add(raw);

		if (admissionLane(current) === "untracked") return;

		if (!visit(current, raw, parent, key)) return;

		const source = getRegisteredTarget(current) ?? current;

		for (const entry of walkDataEntries(source)) {
			if (typeof entry.value !== "object" || entry.value === null) continue;

			if (currentChains === undefined || resolve === undefined) {
				walk(entry.value, currentChains, current, entry.key);

				continue;
			}

			const childChains = resolve(source, currentChains, segmentFor(source, entry.key), entry);

			if (childChains === undefined) continue;

			walk(entry.value, childChains, current, entry.key);
		}
	};

	walk(node, chains);
};

export function internSubtree(
	handle: Handle,
	node: object,
	chains: ChainSet | undefined,
	resolve: ChildChainResolver | undefined,
	capture?: CaptureTables,
): void {
	walkTracked(node, new Set(), chains, resolve, (current) => {
		if (capture === undefined) internNode(handle, current);
		else stageVend(handle, capture, current);

		return true;
	});
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
	walkTracked(node, new Set(), undefined, undefined, (_current, raw) => {
		if (isOccupiedMember(handle, raw)) return false;

		visit(raw, committedIdOf(handle, raw));

		return true;
	});
};

const isNamedSlot = (handle: Handle, raw: object, evicted?: ReadonlyMap<object, number>): boolean =>
	handle.nodes.has(raw) || evicted?.has(raw) === true;

const walkSlots = (
	carried: object,
	node: object,
	isTracked: (raw: object) => boolean,
	visit: (raw: object, parent?: object, key?: string) => boolean,
): void => {
	const visits = new Set<object>();

	const walk = (carriedCurrent: object, current: object, parent?: object, key?: string): void => {
		const raw = occupancyNodeOf(current);
		const looping = visits.has(raw);

		if (!looping) visits.add(raw);

		if (admissionLane(current) === "untracked") return;

		if (!isTracked(raw)) return;

		if (!visit(raw, parent, key) || looping) return;

		for (const entry of walkDataEntries(carriedCurrent)) {
			if (typeof entry.value !== "object" || entry.value === null) continue;

			const child: unknown = Reflect.get(current, entry.key);

			if (typeof child !== "object" || child === null) continue;

			walk(entry.value, child, current, entry.key);
		}
	};

	walk(carried, node);
};

export function evictDepartedClusters(handle: Handle): ReadonlyMap<object, number> {
	const evicted = new Map<object, number>();
	const queued = departingNodes.get(handle);

	if (queued === undefined) return evicted;

	const ungrounded = new Array<object>();

	for (const node of queued) {
		if (!isOccupiedMember(handle, node)) ungrounded.push(node);
	}

	queued.clear();

	const members = new Array<object>();

	for (const node of ungrounded) {
		walkUnoccupiedCluster(handle, node, (raw, id) => {
			members.push(raw);

			if (id !== undefined) evicted.set(raw, id);
		});
	}

	for (const raw of members) handle.nodes.delete(raw);

	for (const id of evicted.values()) handle.byId.delete(id);

	return evicted;
}

export function bindVendedIds(
	handle: Handle,
	node: object,
	carried: object,
	ids: ReadonlyArray<number>,
	capture: CaptureTables | undefined,
	parent?: object,
	key?: PropertyKey,
): void {
	let index = 0;

	walkSlots(
		carried,
		node,
		(raw) => isNamedSlot(handle, raw),
		(raw, walkParent, walkKey) => {
			const id = ids[index];

			if (id === undefined) return true;

			index += 1;

			const held = namedRawOf(handle, id, capture);
			const slotParent = walkParent ?? parent;
			const slotKey: PropertyKey | undefined = walkKey ?? key;

			if (held !== undefined) {
				if (occupancyNodeOf(held) !== raw && slotParent !== undefined && slotKey !== undefined) {
					Reflect.set(slotParent, slotKey, liveOfInterned(held));
				}

				return false;
			}

			if (capture === undefined) commitName(handle, raw, id);
			else stageBind(capture, raw, id);

			return true;
		},
	);
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
	handle: Handle,
	ops: Array<Operation>,
	evicted: ReadonlyMap<object, number>,
): void {
	if (evicted.size === 0) return;

	const claimedMembers = new Set<object>();

	for (let index = ops.length - 1; index >= 0; index--) {
		const operation = ops[index];

		if (operation === undefined) continue;

		const undo = operation.undo;

		if (undo.verb !== "assign") continue;

		const original: unknown = getValueOriginal(undo) ?? undo.value;

		if (typeof original !== "object" || original === null) continue;

		const restoredId = evicted.get(occupancyNodeOf(original));

		if (restoredId === undefined) continue;

		const ids = new Array<number>();
		const claimsBefore = claimedMembers.size;

		walkSlots(
			original,
			original,
			(raw) => isNamedSlot(handle, raw, evicted),
			(raw) => {
				const retiredId = evicted.get(raw);
				const id = retiredId ?? committedIdOf(handle, raw);

				if (id !== undefined) ids.push(id);

				if (retiredId === undefined || claimedMembers.has(raw)) return false;

				claimedMembers.add(raw);

				return true;
			},
		);

		(operation as { undo: Operation["undo"] }).undo =
			claimedMembers.size > claimsBefore
				? createAssignMutation(undo.path, undo.value, original, ids)
				: createLinkMutation(undo.path, restoredId);
	}
}
