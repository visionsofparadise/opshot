import { snapshot, subscribe as valtioSubscribe } from "valtio/vanilla";
import { getCyclicPath } from "../ops/cloneValue";
import { diffSnapshots } from "../ops/diff";
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
}

export interface TransactFrame {
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

const frames: Array<TransactFrame> = [];

const claimFor = (frame: TransactFrame, record: EmitterRecord, wasDirty: boolean): void => {
	if (record.claimedBy !== undefined) return;

	record.claimedBy = frame;
	frame.claimed.push({ record, wasDirty });
};

export const openFrame = (transacted: EmitterRecord | undefined): TransactFrame => {
	const frame: TransactFrame = { claimed: [] };

	frames.push(frame);

	if (transacted !== undefined) claimFor(frame, transacted, transacted.hasUnreported);

	return frame;
};

export const closeFrame = (frame: TransactFrame): void => {
	const index = frames.lastIndexOf(frame);

	if (index === -1) return;

	frames.splice(index, 1);

	for (const claim of frame.claimed) claim.record.claimedBy = undefined;
};

export const armWatchdog = (record: EmitterRecord): void => {
	if (record.disarm !== undefined) return;

	record.lastReported = snapshot(record.writeProxy);
	record.disarm = valtioSubscribe(
		record.writeProxy,
		() => {
			const wasDirty = record.hasUnreported;

			record.hasUnreported = true;

			const outermost = frames[0];

			if (outermost === undefined) {
				scheduleFlush(record);

				return;
			}

			claimFor(outermost, record, wasDirty);
		},
		true,
	);
};

export const disarmWatchdog = (record: EmitterRecord): void => {
	record.disarm?.();
	record.disarm = undefined;
};

const reportRecord = (record: EmitterRecord, meta: unknown): void => {
	const current = snapshot(record.writeProxy);

	record.hasUnreported = false;

	if (current === record.lastReported) return;

	const previous = record.lastReported;

	record.lastReported = current;

	if (!hasListeners(record)) return;

	const ops = diffSnapshots(requireObjectSnapshot(previous), requireObjectSnapshot(current));

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

export const reportFrame = (frame: TransactFrame, meta: unknown): void => {
	bracketDelivery((failures) => {
		for (const claim of frame.claimed) {
			try {
				reportRecord(claim.record, claim.wasDirty ? undefined : meta);
			} catch (error) {
				failures.push(error);
			}
		}
	});
};

export const releaseFrameToWindows = (frame: TransactFrame): void => {
	for (const claim of frame.claimed) scheduleFlush(claim.record);
};

export const settlePendingBare = (record: EmitterRecord): void => {
	reportBareDiff(record);
};

export function emitBareFlush(target: object): void {
	const record = getEmitter(target);

	if (record === undefined) return;

	reportBareDiff(record);
}

export function mintGroupedEmitter(target: object, groupChain: ReadonlyArray<GroupListeners>): EmitterRecord {
	const record = getOrCreateEmitter(target, groupChain);

	armWatchdog(record);

	return record;
}
