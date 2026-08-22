import { emitWrites } from "../emit/emitter";
import { resolveWriteProxy } from "../emit/resolveWriteProxy";
import { requireHandle } from "../handle";
import { isTransactionOpen } from "../transact/nest";
import { runTransaction } from "../transact/transact";
import { applyMutations, type ApplyDirection } from "./applyMutations";
import { isMutation, stampOf, versionOf, type Operation } from "./operation";
import type { OperationPath } from "./path";

const originError = (): Error => new Error("opshot: applyOperations applies a state's operations only to that state");

const tapeError = (): Error => new Error("opshot: applyOperations applies only the next or previous operations");

const isFrozenCopyablePath = (value: unknown): value is OperationPath =>
	Array.isArray(value) && value.every((segment) => typeof segment === "string" || typeof segment === "number");

const isNonNegativeInteger = (value: unknown): value is number =>
	typeof value === "number" && Number.isInteger(value) && value >= 0;

const isWellFormedLinkHalf = (value: unknown): boolean =>
	typeof value === "object" &&
	value !== null &&
	"verb" in value &&
	value.verb === "link" &&
	"path" in value &&
	"ref" in value &&
	isFrozenCopyablePath(value.path) &&
	isNonNegativeInteger(value.ref);

const isWellFormedDeleteHalf = (value: unknown): boolean =>
	typeof value === "object" &&
	value !== null &&
	"verb" in value &&
	value.verb === "delete" &&
	"path" in value &&
	isFrozenCopyablePath(value.path);

const isWellFormedIds = (value: unknown): boolean =>
	value === undefined ||
	(Array.isArray(value) && value.every((id) => typeof id === "number" && Number.isInteger(id) && id >= 0));

const isWellFormedAssignHalf = (value: unknown): boolean =>
	typeof value === "object" &&
	value !== null &&
	"verb" in value &&
	value.verb === "assign" &&
	"value" in value &&
	"path" in value &&
	isFrozenCopyablePath(value.path) &&
	(!("ids" in value) || value.ids === undefined || isWellFormedIds(value.ids));

const isApplicableHalf = (value: unknown): boolean =>
	isMutation(value) || isWellFormedLinkHalf(value) || isWellFormedDeleteHalf(value) || isWellFormedAssignHalf(value);

const assertApplicable: (operation: unknown) => asserts operation is Operation = (operation) => {
	if (isMutation(operation)) {
		throw new Error("opshot: applyOperations applies operation pairs; pass the operation, with a direction");
	}

	if (
		typeof operation !== "object" ||
		operation === null ||
		!("do" in operation) ||
		!("undo" in operation) ||
		!isApplicableHalf(operation.do) ||
		!isApplicableHalf(operation.undo)
	) {
		throw new Error("opshot: applyOperations applies well-formed { do, undo } pairs");
	}
};

/**
 * Applies operations to a state.
 *
 * @param state - State to change.
 * @param operations - Operations to apply.
 * @param direction - `"do"` or `"undo"`.
 * @param meta - Passed to listeners.
 * @returns Nothing.
 */
export function applyOperations(
	state: object,
	operations: ReadonlyArray<Operation>,
	direction: ApplyDirection,
	meta?: unknown,
): void {
	runOperations(state, operations, direction, meta, undefined);
}

export function runOperations(
	state: object,
	operations: ReadonlyArray<Operation>,
	direction: ApplyDirection,
	meta: unknown,
	channelId: object | undefined,
): void {
	for (const operation of operations) assertApplicable(operation);

	const appliedDirection: string = direction;

	if (appliedDirection !== "do" && appliedDirection !== "undo") {
		throw new Error('opshot: applyOperations applies a direction of "do" or "undo"');
	}

	if (isTransactionOpen()) {
		throw new Error(
			"opshot: transact cannot be nested; a transaction cannot contain another. Mutate inside the callback rather than transacting, run transactions in sequence, or call applyOperations at top level.",
		);
	}

	const handle = requireHandle(state, "opshot: applyOperations requires a state");

	emitWrites(handle);

	let ownedCount = 0;

	for (const operation of operations) {
		const stamp = stampOf(operation);

		if (stamp !== undefined && stamp !== handle.stamp) throw originError();

		if (stamp === handle.stamp) ownedCount += 1;
	}

	if (ownedCount > 0 && ownedCount < operations.length) throw originError();

	const owned = operations.length > 0 && ownedCount === operations.length;

	if (owned) {
		let index = 0;

		for (const operation of operations) {
			const expected =
				direction === "do" ? handle.version + 1 + index : handle.version - (operations.length - 1 - index);

			if (versionOf(operation) !== expected) throw tapeError();

			index += 1;
		}
	}

	handle.replaying = true;

	try {
		runTransaction(
			state,
			() => {
				applyMutations(resolveWriteProxy(state), operations, direction, owned ? "restore" : "construct", handle);

				if (owned) {
					handle.version =
						direction === "do" ? handle.version + operations.length : handle.version - operations.length;
				}
			},
			meta,
			channelId,
		);
	} finally {
		handle.replaying = false;
	}
}
