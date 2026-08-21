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

/**
 * Interns `node` on `handle`, minting an id on first admission.
 *
 * `internedById` stores `WeakRef`s. A node whose in-edges empty moves to
 * `departedHold` for one capture window so undo can still resolve the id
 * (spec §3.6). Detached clusters whose interior in-edges keep entries nonempty
 * stay interned until `WeakRef` GC reclaims them.
 *
 * @param handle - State handle.
 * @param node - Node to intern.
 * @returns The intern id, minted or already assigned.
 */
function internNode(handle: Handle, node: object): number {
	const raw = occupancyNodeOf(node);
	const existing = handle.interned.get(raw);

	if (existing !== undefined) {
		handle.internedById.set(existing, new WeakRef(raw));
		handle.departedHold.delete(existing);

		return existing;
	}

	const id = handle.nextInternId;

	handle.nextInternId += 1;
	handle.interned.set(raw, id);
	handle.internedById.set(id, new WeakRef(raw));

	return id;
}

export function internedIdOf(handle: Handle, node: object, capture?: CaptureTables): number | undefined {
	const raw = occupancyNodeOf(node);
	const committed = handle.interned.get(raw);

	if (committed !== undefined) return committed;

	if (capture === undefined) return undefined;

	for (const mint of capture.mints) {
		if (mint.node === raw) return mint.id;
	}

	return undefined;
}

export function stageVend(handle: Handle, capture: CaptureTables, node: object): number {
	const raw = occupancyNodeOf(node);
	const committed = handle.interned.get(raw);

	if (committed !== undefined) {
		handle.internedById.set(committed, new WeakRef(raw));
		handle.departedHold.delete(committed);

		return committed;
	}

	for (const mint of capture.mints) {
		if (mint.node === raw) return mint.id;
	}

	const id = handle.nextInternId + capture.mints.length;

	capture.mints.push({ node: raw, id });

	return id;
}

export function commitVends(handle: Handle, capture: CaptureTables): void {
	if (capture.mints.length === 0) return;

	for (const { node, id } of capture.mints) {
		handle.interned.set(node, id);
		handle.internedById.set(id, new WeakRef(node));
		handle.departedHold.delete(id);
	}

	const last = capture.mints[capture.mints.length - 1];

	if (last !== undefined) handle.nextInternId = last.id + 1;

	capture.mints.length = 0;
}

export function nodeOfInternedId(handle: Handle, id: number): object | undefined {
	const raw = handle.internedById.get(id)?.deref() ?? handle.departedHold.get(id);

	if (raw === undefined) return undefined;

	return liveOfInterned(raw);
}

export function internSubtree(
	handle: Handle,
	node: object,
	skip?: (parent: object, key: string, child: object) => boolean,
	capture?: CaptureTables,
): void {
	const visits = new Set<object>();

	const walk = (current: object): void => {
		const raw = occupancyNodeOf(current);

		if (visits.has(raw)) return;

		visits.add(raw);

		if (admissionLane(current) === "untracked") return;

		if (capture === undefined) internNode(handle, current);
		else stageVend(handle, capture, current);

		for (const entry of walkDataEntries(current)) {
			if (typeof entry.value !== "object" || entry.value === null) continue;

			if (skip?.(current, entry.key, entry.value) === true) continue;

			walk(entry.value);
		}
	};

	walk(node);
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

export function commitDepartures(handle: Handle): void {
	const queued = departingNodes.get(handle);

	if (queued !== undefined) {
		for (const node of queued) {
			if ((handle.inEdges.get(node)?.length ?? 0) > 0) continue;

			const id = handle.interned.get(node);

			if (id === undefined) continue;

			handle.departedHold.set(id, node);
		}

		queued.clear();
	}

	for (const [id, reference] of handle.internedById) {
		if (reference.deref() !== undefined || handle.departedHold.has(id)) continue;

		handle.internedById.delete(id);
	}
}

export function sweepDeparted(handle: Handle): void {
	handle.departedHold.clear();
}
