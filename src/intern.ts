import { unstable_getInternalStates } from "valtio/vanilla";
import { getRegisteredTarget } from "./identity";
import { peelReadProxy } from "./peelReadProxy";
import { walkDataEntries } from "./utils/dataEntries";
import type { Handle } from "./handle";

const { proxyStateMap, proxyCache } = unstable_getInternalStates();

const rawTargetOf = (value: object): object => proxyStateMap.get(value)?.[0] ?? value;

const occupancyNodeOf = (node: object): object => {
	const peeled = peelReadProxy(node);
	const object = typeof peeled === "object" && peeled !== null ? peeled : node;

	return rawTargetOf(getRegisteredTarget(object) ?? object);
};

const liveOfInterned = (raw: object): object => proxyCache.get(raw) ?? raw;

export function internNode(handle: Handle, node: object): number {
	const raw = occupancyNodeOf(node);
	const existing = handle.interned.get(raw);

	if (existing !== undefined) return existing;

	const id = handle.nextInternId;

	handle.nextInternId += 1;
	handle.interned.set(raw, id);
	handle.internedById.set(id, new WeakRef(raw));

	return id;
}

export function internedIdOf(handle: Handle, node: object): number | undefined {
	return handle.interned.get(occupancyNodeOf(node));
}

export function nodeOfInternedId(handle: Handle, id: number): object | undefined {
	const raw = handle.internedById.get(id)?.deref() ?? handle.departedHold.get(id);

	if (raw === undefined) return undefined;

	return liveOfInterned(raw);
}

export function internSubtree(handle: Handle, node: object): void {
	const visits = new Set<object>();

	const walk = (current: object): void => {
		const raw = occupancyNodeOf(current);

		if (visits.has(raw)) return;

		visits.add(raw);
		internNode(handle, current);

		for (const entry of walkDataEntries(current)) {
			if (typeof entry.value === "object" && entry.value !== null) walk(entry.value);
		}
	};

	walk(node);
}

export function holdDeparted(handle: Handle, id: number, node: object): void {
	handle.departedHold.set(id, occupancyNodeOf(node));
}

export function sweepDeparted(handle: Handle): void {
	handle.departedHold.clear();
}
