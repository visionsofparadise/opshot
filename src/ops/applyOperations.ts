import { resolveWriteProxy } from "../emit/resolveWriteProxy";
import { getRegisteredTarget, resolveIdentity } from "../identity";
import { transact } from "../transact";
import { walkDataEntries } from "../utils/dataEntries";
import { getValueOriginal, isMutation, type AssignMutation, type Mutation, type Operation } from "./operation";
import { formatOperationPath, type OperationPath } from "./path";
import { isCanonicalArrayIndex, isCanonicalArrayIndexString, isObjectLike, MAX_ARRAY_LENGTH } from "./predicates";

export type ApplyDirection = "do" | "undo";

interface ValuePayload {
	readonly recorded: unknown;
	readonly fallback: unknown;
}

interface ResolvedTerminal {
	readonly parent: object;
	readonly segment: unknown;
}

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

const unresolvedError = (path: OperationPath): Error =>
	new Error(`opshot: ${formatOperationPath(path)} does not resolve to a supported operation address`);

const isWritableDataDescriptor = (descriptor: PropertyDescriptor | undefined): boolean =>
	descriptor !== undefined && "value" in descriptor && descriptor.writable === true;

const restoreRecordedContent = (attached: object, recorded: object, restored: WeakSet<object>): void => {
	if (restored.has(recorded)) return;

	restored.add(recorded);

	for (const entry of walkDataEntries(recorded, true)) {
		const key = entry.key;
		const attachedDescriptor = Reflect.getOwnPropertyDescriptor(attached, key);

		if (attachedDescriptor !== undefined && !isWritableDataDescriptor(attachedDescriptor)) continue;

		const value: unknown = entry.value;

		if (isObjectLike(value)) {
			const target = getRegisteredTarget(value);

			if (target !== undefined) {
				const present: unknown = attachedDescriptor?.value;

				if (!isObjectLike(present) || resolveIdentity(present) !== resolveIdentity(target)) {
					Reflect.set(attached, key, target);
				}

				const child: unknown = Reflect.get(attached, key);

				if (!isObjectLike(child)) throw new Error(`opshot: replay could not reattach ${key}`);

				restoreRecordedContent(child, value, restored);

				continue;
			}
		}

		Reflect.set(attached, key, value);
	}

	for (const entry of walkDataEntries(attached)) {
		if (!entry.writable) continue;

		if (Object.hasOwn(recorded, entry.key)) continue;

		Reflect.deleteProperty(attached, entry.key);
	}
};

const getValuePayload = (operation: AssignMutation): ValuePayload => {
	const original = getValueOriginal(operation);

	if (original !== undefined) {
		if (isObjectLike(original) && getRegisteredTarget(original) !== undefined)
			return { recorded: original, fallback: undefined };

		return { recorded: original, fallback: operation.value };
	}

	return { recorded: operation.value, fallback: operation.value };
};

const restoreValue = (payload: ValuePayload, attach: (value: unknown) => void, readAttached: () => unknown): void => {
	if (isObjectLike(payload.recorded)) {
		const target = getRegisteredTarget(payload.recorded);

		if (target !== undefined) {
			attach(target);

			const attached = readAttached();

			if (!isObjectLike(attached)) throw new Error("opshot: replay could not read a reattached target");

			restoreRecordedContent(attached, payload.recorded, new WeakSet());

			return;
		}
	}

	attach(payload.fallback);
};

const getInheritedDescriptor = (target: object, key: PropertyKey): PropertyDescriptor | undefined => {
	let prototype = Reflect.getPrototypeOf(target);

	while (prototype !== null) {
		const descriptor = Reflect.getOwnPropertyDescriptor(prototype, key);

		if (descriptor) return descriptor;

		prototype = Reflect.getPrototypeOf(prototype);
	}

	return undefined;
};

const requirePlainSegment = (parent: object, segment: unknown, path: OperationPath): PropertyKey => {
	if (Array.isArray(parent)) {
		if (isCanonicalArrayIndex(segment)) return segment;

		if (typeof segment === "string" && !isCanonicalArrayIndexString(segment)) return segment;

		throw unresolvedError(path);
	}

	if (typeof segment === "string") return segment;

	throw unresolvedError(path);
};

const requirePlainProperty = (parent: object, segment: unknown, path: OperationPath): unknown => {
	if (Array.isArray(parent) && segment === "length") return parent.length;

	const key = requirePlainSegment(parent, segment, path);
	const descriptor = Reflect.getOwnPropertyDescriptor(parent, key);

	if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) throw unresolvedError(path);

	return Reflect.get(parent, key);
};

const resolveTraversalSegment = (parent: unknown, segment: unknown, path: OperationPath): unknown => {
	if (!isObjectLike(parent)) throw unresolvedError(path);

	return requirePlainProperty(parent, segment, path);
};

const resolveTerminal = (root: object, path: OperationPath): ResolvedTerminal => {
	if (path.length === 0) throw new Error("opshot: root operations are not supported");

	let parent: unknown = root;

	for (let index = 0; index < path.length - 1; index++) parent = resolveTraversalSegment(parent, path[index], path);

	if (!isObjectLike(parent)) throw unresolvedError(path);

	return { parent, segment: path[path.length - 1] };
};

const applyPlain = (parent: object, segment: unknown, operation: Mutation): void => {
	const path = operation.path;

	if (Array.isArray(parent) && segment === "length") {
		if (
			operation.verb !== "assign" ||
			typeof operation.value !== "number" ||
			!Number.isInteger(operation.value) ||
			operation.value < 0 ||
			operation.value > MAX_ARRAY_LENGTH
		) {
			throw unresolvedError(path);
		}

		Reflect.set(parent, "length", operation.value);

		return;
	}

	const key = requirePlainSegment(parent, segment, path);
	const descriptor = Reflect.getOwnPropertyDescriptor(parent, key);
	const present = descriptor !== undefined && descriptor.enumerable && "value" in descriptor;

	if (descriptor !== undefined && !present) throw unresolvedError(path);

	if (operation.verb === "delete") {
		Reflect.deleteProperty(parent, key);

		return;
	}

	if (!present) {
		const inheritedDescriptor = getInheritedDescriptor(parent, key);

		if (inheritedDescriptor && !("value" in inheritedDescriptor)) {
			throw new Error(`opshot: ${formatOperationPath(path)} resolves to an inherited accessor`);
		}
	}

	if (!("value" in operation)) throw unresolvedError(path);

	restoreValue(
		getValuePayload(operation),
		(value) => Reflect.set(parent, key, value),
		() => Reflect.get(parent, key),
	);
};

function applyMutations(root: object, operations: ReadonlyArray<Operation>, direction: ApplyDirection): void {
	if (direction === "do") {
		for (const operation of operations) {
			const half = operation.do;
			const terminal = resolveTerminal(root, half.path);

			applyPlain(terminal.parent, terminal.segment, half);
		}

		return;
	}

	for (let index = operations.length - 1; index >= 0; index--) {
		const operation = operations[index];

		if (operation === undefined) continue;

		const half = operation.undo;
		const terminal = resolveTerminal(root, half.path);

		applyPlain(terminal.parent, terminal.segment, half);
	}
}

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
	for (const operation of operations) assertApplicable(operation);

	transact(
		state,
		() => {
			applyMutations(resolveWriteProxy(state), operations, direction);
		},
		meta,
	);
}
