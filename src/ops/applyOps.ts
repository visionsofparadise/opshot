import { resolveEmitterTarget } from "../emit/resolveEmitterTarget";
import { getRegisteredTarget, resolveIdentity } from "../identity";
import { transact } from "../transact";
import { getValueOriginal, isOperation, type Operation, type ReplaceOperation, type AddOperation } from "./operation";
import { assertSafePath, formatOperationPath, type OperationPath } from "./path";

type ValueOperation = AddOperation | ReplaceOperation;

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

const assertApplicable: (operation: unknown) => asserts operation is Operation = (operation) => {
	if (typeof operation === "object" && operation !== null && "do" in operation) {
		throw new Error("opshot: applyOps applies operation halves; pass op.do or op.undo.");
	}

	if (!isOperation(operation)) {
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
	if (!Reflect.deleteProperty(target, key)) throw new Error(`opshot: replay could not remove ${String(key)}`);
};

const restoreRecordedContent = (attached: object, recorded: object, restored: WeakSet<object>): void => {
	if (restored.has(recorded)) return;

	restored.add(recorded);

	const recordedKeys = Reflect.ownKeys(recorded);
	const orderedKeys = Array.isArray(recorded)
		? ["length", ...recordedKeys.filter((key) => key !== "length")]
		: recordedKeys;

	for (const key of orderedKeys) {
		const descriptor = Reflect.getOwnPropertyDescriptor(recorded, key);
		const attachedDescriptor = Reflect.getOwnPropertyDescriptor(attached, key);

		if (!descriptor || !("value" in descriptor) || (attachedDescriptor && !("value" in attachedDescriptor))) continue;

		const value: unknown = descriptor.value;

		if (isObjectLike(value)) {
			const target = getRegisteredTarget(value);

			if (target !== undefined) {
				setOrThrow(attached, key, target);

				const child: unknown = Reflect.get(attached, key);

				if (!isObjectLike(child)) throw new Error(`opshot: replay could not reattach ${String(key)}`);

				restoreRecordedContent(child, value, restored);

				continue;
			}
		}

		setOrThrow(attached, key, value);
	}

	for (const key of Reflect.ownKeys(attached)) {
		if (Object.hasOwn(recorded, key)) continue;

		const descriptor = Reflect.getOwnPropertyDescriptor(attached, key);

		if (descriptor && "value" in descriptor) deleteOrThrow(attached, key);
	}
};

const getValuePayload = (operation: ValueOperation): ValuePayload => {
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
	assertSafePath(path);

	if (path.length === 0) throw new Error("opshot: root operations are not supported");

	let parent: unknown = root;

	for (let index = 0; index < path.length - 1; index++) parent = resolveTraversalSegment(parent, path[index], path);

	if (!isObjectLike(parent)) throw unresolvedError(path);

	return { parent, segment: path[path.length - 1] };
};

const applyPlain = (parent: object, segment: unknown, operation: Operation): void => {
	const path = operation.path;

	if (Array.isArray(parent) && segment === "length") {
		if (
			operation.op !== "replace" ||
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

	if (operation.op === "add" && present) throw unresolvedError(path);

	if (operation.op !== "add" && !present) throw unresolvedError(path);

	if (operation.op === "add") {
		const inheritedDescriptor = getInheritedDescriptor(parent, key);

		if (inheritedDescriptor && !("value" in inheritedDescriptor)) {
			throw new Error(`opshot: ${formatOperationPath(path)} resolves to an inherited accessor`);
		}
	}

	if (operation.op === "remove") {
		deleteOrThrow(parent, key);

		return;
	}

	if (!("value" in operation)) throw unresolvedError(path);

	restoreValue(
		getValuePayload(operation),
		(value) => setOrThrow(parent, key, value),
		() => Reflect.get(parent, key),
	);
};

function applyOperations(root: object, operations: ReadonlyArray<Operation>): void {
	for (const operation of operations) {
		const terminal = resolveTerminal(root, operation.path);

		applyPlain(terminal.parent, terminal.segment, operation);
	}
}

export function applyOps(state: object, operations: ReadonlyArray<Operation>, meta?: unknown): void {
	for (const operation of operations) assertApplicable(operation);

	transact(
		state,
		() => {
			applyOperations(resolveEmitterTarget(state), operations);
		},
		meta,
	);
}
