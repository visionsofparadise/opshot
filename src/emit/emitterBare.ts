import { snapshot, subscribe as valtioSubscribe } from "valtio/vanilla";
import { isState } from "../isState";
import { applyMutations } from "../ops/applyMutations";
import { diffObjects } from "../ops/diff";
import { getOptions } from "../settings";
import { walkDataEntries } from "../utils/dataEntries";
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
	readonly state: object;
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

const unreportedRecords = new Set<EmitterRecord>();

const markUnreported = (record: EmitterRecord): void => {
	record.hasUnreported = true;
	unreportedRecords.add(record);
};

const clearUnreported = (record: EmitterRecord): void => {
	record.hasUnreported = false;
	unreportedRecords.delete(record);
};

let currentTransaction: Transaction | undefined;

export const isTransactionOpen = (): boolean => currentTransaction !== undefined;

const reaches = (from: object, goal: object): boolean => {
	const seen = new Set<object>();

	const visit = (node: object): boolean => {
		if (node === goal) return true;

		const live = targetOf(node);

		if (seen.has(live)) return false;

		seen.add(live);

		for (const entry of walkDataEntries(node)) {
			const child = entry.value;

			if (typeof child !== "object" || child === null) continue;

			if (!isState(child)) continue;

			if (visit(child)) return true;
		}

		return false;
	};

	return visit(from);
};

const isInSameState = (left: object, right: object): boolean =>
	left === right || reaches(left, right) || reaches(right, left);

const claimFor = (transaction: Transaction, record: EmitterRecord, wasDirty: boolean): void => {
	if (record.claimed) return;

	record.claimed = true;
	transaction.claimed.push({ record, wasDirty, baseline: record.lastReported });
};

export const flushPendingWritesOfState = (state: object): void => {
	for (const record of [...unreportedRecords]) {
		if (isInSameState(record.writeProxy, state)) reportBareDiff(record);
	}
};

export const openTransaction = (state: object): Transaction => {
	const transaction: Transaction = { state, claimed: [] };

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
			const wasDirty = record.hasUnreported;

			markUnreported(record);

			const open = currentTransaction;

			if (open === undefined || !isInSameState(record.writeProxy, open.state)) {
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

const reportRange = (
	record: EmitterRecord,
	from: object,
	to: object,
	meta: unknown,
	channelId: object | undefined,
): PendingDelivery | undefined => {
	clearUnreported(record);

	if (from === to) return undefined;

	record.lastReported = to;

	if (!hasListeners(record)) return undefined;

	const ops = diffObjects(requireObjectSnapshot(from), requireObjectSnapshot(to));

	if (ops.length === 0) return undefined;

	return prepareDelivery(record, ops, meta, channelId);
};

const reportRecord = (
	record: EmitterRecord,
	meta: unknown,
	channelId: object | undefined,
): PendingDelivery | undefined =>
	reportRange(record, record.lastReported, snapshot(record.writeProxy), meta, channelId);

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
			const pending = reportRange(
				claim.record,
				claim.record.lastReported,
				snapshot(claim.record.writeProxy),
				meta,
				channelId,
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
		markUnreported(claim.record);
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
		try {
			const { record, baseline } = claim;
			const operations = diffObjects(
				requireObjectSnapshot(snapshot(record.writeProxy)),
				requireObjectSnapshot(baseline),
			);

			if (operations.length > 0) {
				applyMutations(record.writeProxy, operations, "do");
			}

			record.lastReported = baseline;
			clearUnreported(record);
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
