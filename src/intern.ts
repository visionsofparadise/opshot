import { unstable_getInternalStates } from "valtio/vanilla";
import { getRegisteredTarget } from "./identity";
import { peelReadProxy } from "./peelReadProxy";
import { isUnsafeMarked } from "./unsafeTrack";
import { walkDataEntries, type DataEntry } from "./utils/dataEntries";
import { admissionLane } from "./valtio/classify";
import type { Handle } from "./handle";

const { proxyStateMap, proxyCache } = unstable_getInternalStates();

const rawTargetOf = (value: object): object => proxyStateMap.get(value)?.[0] ?? value;

const occupancyNodeOf = (node: object): object => {
	const peeled = peelReadProxy(node);
	const object = typeof peeled === "object" && peeled !== null ? peeled : node;

	return rawTargetOf(getRegisteredTarget(object) ?? object);
};

const liveOfInterned = (raw: object): object => proxyCache.get(raw) ?? raw;

const committedIdOf = (handle: Handle, raw: object): number | undefined => handle.nodes.get(raw)?.id;

const writeId = (handle: Handle, raw: object, id: number): void => {
	const record = handle.nodes.get(raw);

	if (record === undefined) handle.nodes.set(raw, { edges: [], id, exempt: isUnsafeMarked(raw) });
	else {
		if (record.id !== undefined && record.id !== id) handle.byId.delete(record.id);

		record.id = id;
	}

	handle.byId.set(id, raw);
};

const commitName = (handle: Handle, raw: object, id: number): void => {
	writeId(handle, raw, id);

	if (id >= handle.nextInternId) handle.nextInternId = id + 1;
};

/**
 * Interns `node` on `handle`, minting an id on first admission. Undo of a departure rebinds via the `ids` the assign half carries.
 *
 * @param handle - State handle.
 * @param node - Node to intern.
 * @returns The intern id, minted or already assigned.
 */
export function internNode(handle: Handle, node: object): number {
	const raw = occupancyNodeOf(node);
	const record = handle.nodes.get(raw);

	if (record?.id !== undefined && handle.byId.get(record.id) === raw) return record.id;

	if (handle.replaying && record?.id !== undefined && handle.byId.get(record.id) === undefined) {
		handle.byId.set(record.id, raw);

		return record.id;
	}

	const id = handle.nextInternId;

	handle.nextInternId += 1;
	writeId(handle, raw, id);

	return id;
}

export function internedIdOf(handle: Handle, node: object): number | undefined {
	return committedIdOf(handle, occupancyNodeOf(node));
}

export function nodeOfInternedId(handle: Handle, id: number): object | undefined {
	const raw = handle.byId.get(id);

	if (raw === undefined) return undefined;

	return liveOfInterned(raw);
}

const walkTracked = (
	node: object,
	visits: Set<object>,
	skipChild: ((parent: object, entry: DataEntry) => boolean) | undefined,
	visit: (current: object, raw: object, parent?: object, key?: string) => boolean,
): void => {
	const walk = (current: object, parent?: object, key?: string): void => {
		const raw = occupancyNodeOf(current);

		if (visits.has(raw)) return;

		visits.add(raw);

		if (admissionLane(current) === "untracked") return;

		if (!visit(current, raw, parent, key)) return;

		const source = getRegisteredTarget(current) ?? current;

		for (const entry of walkDataEntries(source)) {
			if (typeof entry.value !== "object" || entry.value === null) continue;

			if (skipChild?.(source, entry) === true) continue;

			walk(entry.value, current, entry.key);
		}
	};

	walk(node);
};

export function internSubtree(
	handle: Handle,
	node: object,
	skipChild: ((parent: object, entry: DataEntry) => boolean) | undefined,
): void {
	walkTracked(node, new Set(), skipChild, (current) => {
		internNode(handle, current);

		return true;
	});
}

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

export function bindVendedIds(
	handle: Handle,
	node: object,
	carried: object,
	ids: ReadonlyArray<number>,
	parent?: object,
	key?: PropertyKey,
): void {
	let index = 0;

	walkSlots(
		carried,
		node,
		() => true,
		(raw, walkParent, walkKey) => {
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

			commitName(handle, raw, id);

			return true;
		},
	);
}
