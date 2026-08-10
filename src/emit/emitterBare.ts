import { snapshot, subscribe as valtioSubscribe } from "valtio/vanilla";
import { applyMutations } from "../ops/applyMutations";
import { getCyclicPath } from "../ops/cloneValue";
import { diffObjects } from "../ops/diff";
import { formatOperationPath } from "../ops/path";
import { bracketDelivery, deliver } from "./emitterDeliver";
import {
	getEmitter,
	getOrCreateEmitter,
	hasListeners,
	type EmitterRecord,
	type GroupListeners,
} from "./emitterRegistry";

interface Claim {
	readonly record: EmitterRecord;
	readonly wasDirty: boolean;
	readonly baseline: object;
}

export interface Transaction {
	readonly claimed: Array<Claim>;
}

const augmentBareCycleError = (error: unknown): Error | undefined => {
	const path = getCyclicPath(error);

	if (path === undefined) return undefined;

	return new Error(
		`opshot: a bare write created a cyclic value at ${formatOperationPath(path)}. Cycles cannot be tracked. This surfaced asynchronously because the write was not inside transact. Use transact for catchable cycle errors, ignore() for back-linked structures, or ids.`,
	);
};

const requireObjectSnapshot = (value: unknown): object => {
	if (value !== null && (typeof value === "object" || typeof value === "function")) return value;

	throw new Error("opshot: state snapshots must have an object root");
};

const scheduleFlush = (record: EmitterRecord): void => {
	if (record.pending) return;

	record.pending = true;

	void Promise.resolve().then(() => {
		const { emitOn } = record;

		if (emitOn === undefined) {
			record.pending = false;
			emitBareFlush(record.writeProxy);

			return;
		}

		emitOn(() => {
			record.pending = false;
			emitBareFlush(record.writeProxy);
		});
	});
};

let currentTransaction: Transaction | undefined;

export const isTransactionOpen = (): boolean => currentTransaction !== undefined;

const claimFor = (transaction: Transaction, record: EmitterRecord, wasDirty: boolean): void => {
	if (record.claimed) return;

	record.claimed = true;
	transaction.claimed.push({ record, wasDirty, baseline: record.lastReported });
};

export const openTransaction = (): Transaction => {
	const transaction: Transaction = { claimed: [] };

	currentTransaction = transaction;

	return transaction;
};

export const closeTransaction = (transaction: Transaction): void => {
	if (currentTransaction !== transaction) return;

	currentTransaction = undefined;

	for (const claim of transaction.claimed) claim.record.claimed = false;
};

export const armEmitter = (record: EmitterRecord): void => {
	if (record.disarmEmission !== undefined) return;

	record.lastReported = snapshot(record.writeProxy);
	record.disarmEmission = valtioSubscribe(
		record.writeProxy,
		() => {
			const wasDirty = record.hasUnreported;

			record.hasUnreported = true;

			const open = currentTransaction;

			if (open === undefined) {
				scheduleFlush(record);

				return;
			}

			claimFor(open, record, wasDirty);
		},
		true,
	);
};

export const disarmEmitter = (record: EmitterRecord): void => {
	record.disarmEmission?.();
	record.disarmEmission = undefined;
};

const reportRecord = (record: EmitterRecord, meta: unknown): void => {
	const current = snapshot(record.writeProxy);

	record.hasUnreported = false;

	if (current === record.lastReported) return;

	const previous = record.lastReported;

	record.lastReported = current;

	if (!hasListeners(record)) return;

	const ops = diffObjects(requireObjectSnapshot(previous), requireObjectSnapshot(current));

	if (ops.length === 0) return;

	deliver(record, ops, meta);
};

const reportBareDiff = (record: EmitterRecord): void => {
	try {
		reportRecord(record, undefined);
	} catch (error) {
		throw augmentBareCycleError(error) ?? error;
	}
};

export const reportTransaction = (transaction: Transaction, meta: unknown): void => {
	bracketDelivery((failures) => {
		for (const claim of transaction.claimed) {
			try {
				reportRecord(claim.record, claim.wasDirty ? undefined : meta);
			} catch (error) {
				failures.push(error);
			}
		}
	});
};

export const releaseTransactionToWindows = (transaction: Transaction): void => {
	for (const claim of transaction.claimed) scheduleFlush(claim.record);
};

export const rollbackTransaction = (transaction: Transaction): void => {
	for (const claim of [...transaction.claimed]) {
		if (claim.wasDirty) continue;

		const { record, baseline } = claim;
		const operations = diffObjects(
			requireObjectSnapshot(snapshot(record.writeProxy)),
			requireObjectSnapshot(baseline),
		);

		if (operations.length === 0) {
			record.lastReported = baseline;
			record.hasUnreported = false;

			continue;
		}

		applyMutations(record.writeProxy, operations, "do");
		record.lastReported = baseline;
		record.hasUnreported = false;
	}
};

export const settlePendingBare = (record: EmitterRecord): void => {
	reportBareDiff(record);
};

export function emitBareFlush(state: object): void {
	const record = getEmitter(state);

	if (record === undefined) return;

	reportBareDiff(record);
}

export function mintGroupedEmitter(state: object, groupChain: ReadonlyArray<GroupListeners>): EmitterRecord {
	const record = getOrCreateEmitter(state, groupChain);

	armEmitter(record);

	return record;
}
