import { rawOf } from "../node";
import { drainDeliveries, enqueueDelivery, prepareDelivery } from "./emitterDeliver";
import type { DirtyIndex, Handle, PendingOperation } from "../handle";
import type { Operation } from "../operation";

export function recordOperation(handle: Handle, raw: object, pending: PendingOperation): void {
	let byKey = handle.pendingIndex.get(raw);

	if (byKey === undefined) {
		byKey = new Map();
		handle.pendingIndex.set(raw, byKey);
	}

	const index = byKey.get(pending.key);
	const existing = index === undefined ? undefined : handle.pending[index];

	if (existing !== undefined && Object.is(existing.meta, pending.meta)) {
		existing.after = pending.after;
		existing.hasAfter = pending.hasAfter;

		return;
	}

	handle.pending.push(pending);
	byKey.set(pending.key, handle.pending.length - 1);

	if (handle.scheduledFlush !== undefined) return;

	const run = (): void => {
		if (handle.scheduledFlush !== run) return;

		flushWindow(handle);
	};

	handle.scheduledFlush = run;

	void Promise.resolve().then(() => {
		if (handle.scheduledFlush !== run) return;

		const emitOn = handle.emitOn;

		if (emitOn === undefined) run();
		else emitOn(run);
	});
}

export function flushWindow(handle: Handle): void {
	handle.scheduledFlush = undefined;

	const pending = handle.pending.splice(0);

	handle.pendingIndex.clear();

	const operations = new Array<Operation>();

	for (const item of pending) {
		if (item.hasBefore === item.hasAfter && (!item.hasBefore || Object.is(item.before, item.after))) continue;

		const operation: Operation = {
			node: item.node,
			key: item.key,
			meta: item.meta,
			...(item.hasBefore ? { before: item.before } : {}),
			...(item.hasAfter ? { after: item.after } : {}),
		};

		operations.push(Object.freeze(operation));
	}

	if (operations.length === 0) return;

	const edges = new Map<object, Set<string>>();
	const nodes = new Set<object>();

	for (const operation of operations) {
		const raw = rawOf(operation.node);
		let keys = edges.get(raw);

		if (keys === undefined) {
			keys = new Set();
			edges.set(raw, keys);
		}

		keys.add(operation.key);
		nodes.add(raw);
	}

	const dirty: DirtyIndex = { edges, nodes };

	enqueueDelivery(prepareDelivery(handle, operations, dirty));
	drainDeliveries();
}
