import { snapshot, subscribe as valtioSubscribe } from "valtio/vanilla";
import { applyMutations } from "../ops/applyMutations";
import { absorbFormationPulse } from "../ops/commitWalk";
import { diffObjects } from "../ops/diff";
import { getOptions } from "../settings";
import {
	drainDeliveries,
	enqueueDelivery,
	prepareDelivery,
	recordDeliveryFailure,
	type PendingDelivery,
} from "./emitterDeliver";
import {
	getEmitter,
	getOrCreateEmitter,
	hasListeners,
	targetOf,
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

const requireObjectSnapshot = (value: unknown): object => {
	if (value !== null && (typeof value === "object" || typeof value === "function")) return value;

	throw new Error("opshot: state snapshots must have an object root");
};

const scheduleFlush = (record: EmitterRecord): void => {
	if (record.pending) return;

	record.pending = true;

	void Promise.resolve().then(() => {
		const emitOn = getOptions(targetOf(record.writeProxy))?.emitOn;

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
	currentTransaction = undefined;

	for (const claim of transaction.claimed) claim.record.claimed = false;
};

export const armEmitter = (record: EmitterRecord): void => {
	if (record.disarmEmission !== undefined) return;

	record.disarmEmission = valtioSubscribe(
		record.writeProxy,
		() => {
			absorbFormationPulse(targetOf(record.writeProxy));

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

const reportRecord = (
	record: EmitterRecord,
	meta: unknown,
	channelId: object | undefined,
): PendingDelivery | undefined => {
	const current = snapshot(record.writeProxy);

	record.hasUnreported = false;

	if (current === record.lastReported) return undefined;

	const previous = record.lastReported;

	record.lastReported = current;

	if (!hasListeners(record)) return undefined;

	const ops = diffObjects(requireObjectSnapshot(previous), requireObjectSnapshot(current));

	if (ops.length === 0) return undefined;

	return prepareDelivery(record, ops, meta, channelId);
};

export const reportBareDiff = (record: EmitterRecord): void => {
	const pending = reportRecord(record, undefined, undefined);

	if (pending === undefined) return;

	enqueueDelivery(pending);
	drainDeliveries();
};

interface RecordFailure {
	readonly record: EmitterRecord;
	readonly error: unknown;
}

interface TransactionReport {
	readonly prepared: ReadonlyArray<PendingDelivery>;
	readonly failures: ReadonlyArray<RecordFailure>;
}

export const prepareTransactionReport = (
	transaction: Transaction,
	meta: unknown,
	channelId: object | undefined,
): TransactionReport => {
	const prepared: Array<PendingDelivery> = [];
	const failures: Array<RecordFailure> = [];

	for (const claim of transaction.claimed) {
		try {
			const pending = reportRecord(
				claim.record,
				claim.wasDirty ? undefined : meta,
				claim.wasDirty ? undefined : channelId,
			);

			if (pending !== undefined) prepared.push(pending);
		} catch (error) {
			failures.push({ record: claim.record, error });
		}
	}

	return { prepared, failures };
};

export const failedRecords = (report: TransactionReport): ReadonlySet<EmitterRecord> =>
	new Set(report.failures.map((failure) => failure.record));

export const deliverPreparedReport = (report: TransactionReport): void => {
	for (const failure of report.failures) recordDeliveryFailure(failure.error);

	for (const pending of report.prepared) enqueueDelivery(pending);

	drainDeliveries();
};

export const restoreDirtyLedgers = (transaction: Transaction): void => {
	for (const claim of transaction.claimed) {
		if (!claim.wasDirty) continue;

		claim.record.lastReported = claim.baseline;
		claim.record.hasUnreported = true;
		claim.record.pending = false;
	}
};

export const releaseTransactionToWindows = (transaction: Transaction, exclude?: ReadonlySet<EmitterRecord>): void => {
	for (const claim of transaction.claimed) {
		if (exclude?.has(claim.record) === true) continue;

		scheduleFlush(claim.record);
	}
};

export const rollbackTransaction = (transaction: Transaction): void => {
	const failures: Array<unknown> = [];

	for (const claim of [...transaction.claimed]) {
		if (claim.wasDirty) continue;

		try {
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
		} catch (error) {
			failures.push(error);
		}
	}

	if (failures.length === 0) return;

	if (failures.length === 1) throw failures[0];

	throw new AggregateError(failures, "opshot: failures during rollback");
};

export function emitBareFlush(state: object): void {
	const record = getEmitter(state);

	if (record === undefined) return;

	reportBareDiff(record);
}

export function mintGroupedEmitter(writeProxy: object, groupChain: ReadonlyArray<GroupListeners>): EmitterRecord {
	const record = getOrCreateEmitter(writeProxy, groupChain);

	armEmitter(record);

	return record;
}
