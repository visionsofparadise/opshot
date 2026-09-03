import { isIgnored } from "./ignore";
import { proxyOf, recordOf, rawOf } from "./node";
import { isUnsafeMarked } from "./unsafeTrack";
import { walkDataEntries, type DataEntry } from "./utils/dataEntries";
import type { Handle } from "./handle";

export function isTrackedEntry(
	_handle: Handle,
	_parent: object,
	entry: DataEntry,
): entry is DataEntry & { value: object } {
	return (
		entry.writable &&
		typeof entry.value === "object" &&
		entry.value !== null &&
		!isIgnored(entry.value) &&
		!Object.isFrozen(entry.value)
	);
}

const walkTrackedEntries = (handle: Handle, node: object, visit: (child: object) => void): void => {
	for (const entry of walkDataEntries(node)) {
		if (isTrackedEntry(handle, node, entry)) visit(entry.value);
	}
};

const flipUnexempt = (handle: Handle, node: object): void => {
	const record = recordOf(rawOf(node));
	const membership = record?.memberships.get(handle);

	if (!membership?.exempt) return;

	membership.exempt = false;
	walkTrackedEntries(handle, rawOf(node), (child) => {
		flipUnexempt(handle, child);
	});
};

export function attach(handle: Handle, parent: object, child: object): void {
	const parentRecord = recordOf(parent);
	const parentMembership = parentRecord?.memberships.get(handle);

	if (parentMembership === undefined) return;

	const rawChild = rawOf(child);

	proxyOf(rawChild);

	const record = recordOf(rawChild);

	if (record === undefined) return;

	const edgeExempt = parentMembership.exempt || isUnsafeMarked(rawChild);
	let membership = record.memberships.get(handle);

	if (membership === undefined) {
		membership = { edges: 0, exempt: edgeExempt };
		record.memberships.set(handle, membership);
	}

	membership.edges += 1;

	if (membership.edges === 1) {
		walkTrackedEntries(handle, rawChild, (grandchild) => {
			attach(handle, rawChild, grandchild);
		});

		return;
	}

	if (membership.exempt && !edgeExempt) flipUnexempt(handle, rawChild);
}

export function detach(handle: Handle, child: object): void {
	const rawChild = rawOf(child);
	const record = recordOf(rawChild);
	const membership = record?.memberships.get(handle);

	if (record === undefined || membership === undefined) return;

	membership.edges -= 1;

	if (membership.edges > 0) return;

	record.memberships.delete(handle);
	walkTrackedEntries(handle, rawChild, (grandchild) => {
		if (recordOf(grandchild)?.memberships.has(handle) === true) detach(handle, grandchild);
	});
}

export function evict(handle: Handle, node: object): void {
	const rawNode = rawOf(node);
	const record = recordOf(rawNode);

	if (record === undefined) return;

	record.memberships.delete(handle);
	walkTrackedEntries(handle, rawNode, (grandchild) => {
		if (recordOf(grandchild)?.memberships.has(handle) === true) detach(handle, grandchild);
	});
}
