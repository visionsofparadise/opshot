import { resolveWriteProxy } from "../emit/resolveWriteProxy";
import { getRegisteredTarget, resolveIdentity } from "../identity";
import { transact } from "../transact";
import { walkDataEntries } from "../utils/dataEntries";
import { getValueOriginal, isMutation, type AssignMutation, type Mutation } from "./operation";
import { formatOperationPath, type OperationPath } from "./path";

interface ValuePayload {
	readonly recorded: unknown;
	readonly fallback: unknown;
}

interface ResolvedTerminal {
	readonly parent: object;
	readonly segment: unknown;
}

const isObjectLike = (value: unknown): value is object =>
	value !== null && (typeof value === "object" || typeof value === "function");
const sameValueZero = (first: unknown, second: unknown): boolean =>
	first === second || (first !== first && second !== second);
const sameIdentity = (first: unknown, second: unknown): boolean =>
	sameValueZero(resolveIdentity(first), resolveIdentity(second));

const assertApplicable: (operation: unknown) => asserts operation is Mutation = (operation) => {
	if (typeof operation === "object" && operation !== null && "do" in operation) {
		throw new Error("opshot: applyOperations applies operation halves; pass op.do or op.undo.");
	}

	if (!isMutation(operation)) {
		throw new Error(
			"opshot: this op is a copy (spread, JSON, or structuredClone) and has lost its value. Apply the op objects the listener delivered; never copy them.",
		);
	}
};

const unresolvedError = (path: OperationPath): Error =>
	new Error(`opshot: ${formatOperationPath(path)} does not resolve to a supported operation address`);

const matchesAppliedValue = (current: unknown, expected: unknown): boolean => {
	if (isObjectLike(current) && isObjectLike(expected)) return sameIdentity(current, expected);

	return Object.is(current, expected);
};

const setOrThrow = (target: object, key: PropertyKey, value: unknown): void => {
	const written = Reflect.set(target, key, value);
	const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
	const current: unknown = descriptor && "value" in descriptor ? Reflect.get(target, key) : undefined;

	if (!written || !descriptor || !("value" in descriptor) || !matchesAppliedValue(current, value)) {
		throw new Error(`opshot: replay could not restore ${String(key)}`);
	}
};

const deleteOrThrow = (target: object, key: PropertyKey): void => {
	if (!Reflect.deleteProperty(target, key)) throw new Error(`opshot: replay could not delete ${String(key)}`);
};

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
					setOrThrow(attached, key, target);
				}

				const child: unknown = Reflect.get(attached, key);

				if (!isObjectLike(child)) throw new Error(`opshot: replay could not reattach ${key}`);

				restoreRecordedContent(child, value, restored);

				continue;
			}
		}

		setOrThrow(attached, key, value);
	}

	for (const entry of walkDataEntries(attached)) {
		if (!entry.writable) continue;

		if (Object.hasOwn(recorded, entry.key)) continue;

		deleteOrThrow(attached, entry.key);
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

const isCanonicalArrayIndex = (segment: unknown): segment is number =>
	Number.isInteger(segment) && typeof segment === "number" && segment >= 0 && segment < 4_294_967_295;
const isCanonicalArrayIndexString = (segment: string): boolean => {
	const index = Number(segment);

	return Number.isInteger(index) && index >= 0 && index < 4_294_967_295 && String(index) === segment;
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
			operation.value > 4_294_967_295
		) {
			throw unresolvedError(path);
		}

		setOrThrow(parent, "length", operation.value);

		return;
	}

	const key = requirePlainSegment(parent, segment, path);
	const descriptor = Reflect.getOwnPropertyDescriptor(parent, key);
	const present = descriptor !== undefined && descriptor.enumerable && "value" in descriptor;

	if (descriptor !== undefined && !present) throw unresolvedError(path);

	if (operation.verb === "delete") {
		deleteOrThrow(parent, key);

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
		(value) => setOrThrow(parent, key, value),
		() => Reflect.get(parent, key),
	);
};

function applyMutations(root: object, operations: ReadonlyArray<Mutation>): void {
	for (const operation of operations) {
		const terminal = resolveTerminal(root, operation.path);

		applyPlain(terminal.parent, terminal.segment, operation);
	}
}

/**
 * Applies operations to a state.
 *
 * @param state - State to change.
 * @param operations - Operations to apply.
 * @param meta - Passed to listeners.
 * @returns Nothing.
 */
export function applyOperations(state: object, operations: ReadonlyArray<Mutation>, meta?: unknown): void {
	for (const operation of operations) assertApplicable(operation);

	transact(
		state,
		() => {
			applyMutations(resolveWriteProxy(state), operations);
		},
		meta,
	);
}
