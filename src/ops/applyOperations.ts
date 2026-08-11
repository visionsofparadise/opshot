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
 * Applies operation pairs to a state in the given direction. A delivered batch is the
 * self-contained unit: re-applying it at a matching state is a no-op for all three verbs, but a
 * link's referent is defined by its stream position, so an op is not meaningful in isolation.
 *
 * `"do"` applies each pair's do half in delivery order. `"undo"` applies each pair's undo half in
 * reverse delivery order. The library owns that ordering and the target-path rule: a link applies
 * only after the ops that establish its ref target's path in that direction. Runs through `transact`
 * and cannot run inside one — call at top level.
 *
 * Halves are assign, delete, or link (`verb`, `path`, and on assign `.value`, on link `.ref`). Link
 * ref resolvability is batch-scoped: a ref is defined by earlier ops in the stream and is not
 * preflighted. A well-formed link half applies without the brand; assign and delete still require it.
 * Never spread, JSON-round-trip, or `structuredClone` a value-bearing half before applying it.
 * A link half's `ref` is plain data, so sharing survives serialization as addressing rather than as
 * in-memory identity — but a batch is only appliable where every value-bearing and delete half still
 * carries its brand, so transport means re-minting those halves rather than applying copies. Value
 * carriage of unfound candidates and fresh-subtree internal aliasing keep in-memory residue only.
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
