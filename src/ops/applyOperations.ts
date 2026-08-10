import { resolveWriteProxy } from "../emit/resolveWriteProxy";
import { runTransaction } from "../transact";
import { applyMutations, type ApplyDirection } from "./applyMutations";
import { isMutation, type Operation } from "./operation";

const assertApplicable: (operation: unknown) => asserts operation is Operation = (operation) => {
	if (isMutation(operation)) {
		throw new Error("opshot: applyOperations applies operation pairs; pass the operation, with a direction");
	}

	if (
		typeof operation !== "object" ||
		operation === null ||
		!("do" in operation) ||
		!("undo" in operation) ||
		!isMutation(operation.do) ||
		!isMutation(operation.undo)
	) {
		throw new Error(
			"opshot: this op is a copy (spread, JSON, or structuredClone) and has lost its value. Apply the op objects the listener delivered; never copy them.",
		);
	}
};

/**
 * Applies operation pairs to a state in the given direction.
 *
 * `"do"` applies each pair's do half in delivery order. `"undo"` applies each pair's undo half in reverse delivery order.
 *
 * @param state - State to change.
 * @param operations - Operation pairs to apply.
 * @param direction - Which half to apply, and the ordering that direction implies.
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
