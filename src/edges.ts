import { nonWritablePropertyError, rejectionError } from "./boundaryErrors";
import { classifyValue, isDangerousKind } from "./classify";
import { isIgnored } from "./ignore";
import { proxyOf, recordOf, rawOf } from "./node";
import { isUnsafeMarked } from "./unsafeTrack";
import { walkDataEntries, type DataEntry } from "./utils/dataEntries";
import type { Handle } from "./handle";

export const isTrackedEntry = (value: unknown, writable: boolean): value is object =>
	writable && typeof value === "object" && value !== null && !isIgnored(value) && !Object.isFrozen(value);

const checkNode = (node: object, entries: Array<DataEntry>, route: ReadonlyArray<string>): void => {
	const kind = classifyValue(node);

	if (isDangerousKind(kind)) throw rejectionError(node, kind, route);

	for (const entry of entries) {
		if (typeof entry.value === "function") {
			if (kind === "cleanClass") throw rejectionError(node, "cleanClass", [...route, entry.key]);

			continue;
		}

		if (typeof entry.value !== "object" || entry.value === null) continue;

		if (isIgnored(entry.value) || Object.isFrozen(entry.value)) continue;

		if (!entry.writable) throw nonWritablePropertyError(node, [...route, entry.key]);
	}
};

const descend = (handle: Handle, node: object, route: ReadonlyArray<string>, checked: boolean): void => {
	const entries = walkDataEntries(node);

	if (checked) checkNode(node, entries, route);

	for (const entry of entries) {
		if (isTrackedEntry(entry.value, entry.writable))
			attach(handle, node, entry.key, entry.value, [...route, entry.key]);
	}
};

const flip = (handle: Handle, node: object, route: ReadonlyArray<string>): void => {
	const membership = recordOf(node)?.memberships.get(handle);

	if (!membership?.exempt) return;

	membership.exempt = false;

	const entries = walkDataEntries(node);

	checkNode(node, entries, route);

	for (const entry of entries) {
		if (!isTrackedEntry(entry.value, entry.writable)) continue;

		const child = rawOf(entry.value);

		if (recordOf(child)?.memberships.has(handle) === true) flip(handle, child, [...route, entry.key]);
	}
};

const cascade = (handle: Handle, node: object, keys: ReadonlySet<string>): void => {
	for (const key of keys) {
		const value: unknown = Reflect.get(node, key);

		if (typeof value !== "object" || value === null) continue;

		const child = rawOf(value);

		if (recordOf(child)?.memberships.has(handle) === true) detach(handle, child);
	}
};

export function attach(handle: Handle, parent: object, key: string, child: object, route: ReadonlyArray<string>): void {
	const parentMembership = recordOf(parent)?.memberships.get(handle);

	if (parentMembership === undefined) return;

	parentMembership.keys.add(key);

	const rawChild = rawOf(child);

	proxyOf(rawChild);

	const record = recordOf(rawChild);

	if (record === undefined) return;

	const edgeExempt = parentMembership.exempt || isUnsafeMarked(rawChild);
	const membership = record.memberships.get(handle);

	if (membership === undefined) {
		record.memberships.set(handle, { edges: 1, exempt: edgeExempt, keys: new Set() });
		descend(handle, rawChild, route, !edgeExempt);

		return;
	}

	membership.edges += 1;

	if (membership.exempt && !edgeExempt) flip(handle, rawChild, route);
}

export function attachRoot(handle: Handle, root: object, exempt: boolean): void {
	const record = recordOf(root);

	if (record === undefined) return;

	record.memberships.set(handle, { edges: 1, exempt, keys: new Set() });

	try {
		descend(handle, root, [], !exempt);
	} catch (error) {
		evict(handle, root);

		throw error;
	}
}

export function detach(handle: Handle, child: object): void {
	const rawChild = rawOf(child);
	const record = recordOf(rawChild);
	const membership = record?.memberships.get(handle);

	if (record === undefined || membership === undefined) return;

	membership.edges -= 1;

	if (membership.edges > 0) return;

	record.memberships.delete(handle);
	cascade(handle, rawChild, membership.keys);
}

export function evict(handle: Handle, node: object): void {
	const rawNode = rawOf(node);
	const record = recordOf(rawNode);
	const membership = record?.memberships.get(handle);

	if (record === undefined || membership === undefined) return;

	record.memberships.delete(handle);
	cascade(handle, rawNode, membership.keys);
}
