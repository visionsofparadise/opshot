import { resolveWriteProxy } from "../emit/resolveWriteProxy";
import { runTransaction } from "../transact";
import { applyMutations, type ApplyDirection } from "./applyMutations";
import { isMutation, type Operation } from "./operation";
import type { OperationPath } from "./path";

const isFrozenCopyablePath = (value: unknown): value is OperationPath =>
	Array.isArray(value) && value.every((segment) => typeof segment === "string" || typeof segment === "number");

const isWellFormedLinkHalf = (value: unknown): boolean =>
	typeof value === "object" &&
	value !== null &&
	"verb" in value &&
	value.verb === "link" &&
	"path" in value &&
	"ref" in value &&
	isFrozenCopyablePath(value.path) &&
	isFrozenCopyablePath(value.ref);

const isApplicableHalf = (value: unknown): boolean => isMutation(value) || isWellFormedLinkHalf(value);

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
		throw new Error(
			"opshot: this op is a copy (spread, JSON, or structuredClone) and has lost its value. Apply the op objects the listener delivered; never copy them.",
		);
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

	runTransaction(
		state,
		() => {
			applyMutations(resolveWriteProxy(state), operations, direction);
		},
		meta,
		channelId,
	);
}
