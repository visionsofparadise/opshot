import { getRegisteredTarget, resolveIdentity } from "../identity";
import { internSubtree, nodeOfInternedId } from "../intern";
import { walkDataEntries } from "../utils/dataEntries";
import { cloneValue } from "./cloneValue";
import { getValueOriginal, type AssignMutation, type LinkMutation, type Mutation, type Operation } from "./operation";
import { formatOperationPath, type OperationPath } from "./path";
import { isCanonicalArrayIndex, isCanonicalArrayIndexString, isObjectLike, MAX_ARRAY_LENGTH } from "./predicates";
import type { Handle } from "../handle";

export type ApplyDirection = "do" | "undo";

interface ValuePayload {
	readonly recorded: unknown;
	readonly fallback: unknown;
}

interface ResolvedTerminal {
	readonly parent: object;
	readonly segment: unknown;
}

class ReplayReattachError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ReplayReattachError";
	}
}

const unresolvedError = (path: OperationPath): Error =>
	new Error(`opshot: ${formatOperationPath(path)} does not resolve to a supported operation address`);

const linkError = (path: OperationPath, ref: number, reason: string): Error =>
	new Error(`opshot: link at ${formatOperationPath(path)} with ref ${String(ref)} ${reason}`);

const isWritableDataDescriptor = (descriptor: PropertyDescriptor | undefined): boolean =>
	descriptor !== undefined && "value" in descriptor && descriptor.writable === true;

const restoreRecordedContent = (
	attached: object,
	recorded: object,
	restored: WeakSet<object>,
	identity: "restore" | "construct",
): void => {
	if (restored.has(recorded)) return;

	restored.add(recorded);

	for (const entry of walkDataEntries(recorded, true)) {
		const key = entry.key;
		const attachedDescriptor = Reflect.getOwnPropertyDescriptor(attached, key);

		if (attachedDescriptor !== undefined && !isWritableDataDescriptor(attachedDescriptor)) continue;

		const value: unknown = entry.value;

		if (identity === "restore" && isObjectLike(value)) {
			const target = getRegisteredTarget(value);

			if (target !== undefined) {
				const present: unknown = attachedDescriptor?.value;

				if (!isObjectLike(present) || resolveIdentity(present) !== resolveIdentity(target)) {
					Reflect.set(attached, key, target);
				}

				const child: unknown = Reflect.get(attached, key);

				if (!isObjectLike(child)) throw new ReplayReattachError(`opshot: replay could not reattach ${key}`);

				restoreRecordedContent(child, value, restored, identity);

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

const getValuePayload = (operation: AssignMutation, identity: "restore" | "construct"): ValuePayload => {
	const original = identity === "restore" ? (getValueOriginal(operation) ?? operation.value) : operation.value;

	return {
		recorded: original,
		fallback: isObjectLike(original) ? cloneValue(original, new WeakMap(), operation.path) : original,
	};
};

const restoreValue = (
	payload: ValuePayload,
	attach: (value: unknown) => void,
	readAttached: () => unknown,
	identity: "restore" | "construct",
): void => {
	if (identity === "restore" && isObjectLike(payload.recorded)) {
		const target = getRegisteredTarget(payload.recorded);

		if (target !== undefined) {
			attach(target);

			const attached = readAttached();

			if (!isObjectLike(attached)) {
				throw new ReplayReattachError("opshot: replay could not read a reattached target");
			}

			restoreRecordedContent(attached, payload.recorded, new WeakSet(), identity);

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
	if (path.length === 0) throw unresolvedError(path);

	let parent: unknown = root;

	for (let index = 0; index < path.length - 1; index++) parent = resolveTraversalSegment(parent, path[index], path);

	if (!isObjectLike(parent)) throw unresolvedError(path);

	return { parent, segment: path[path.length - 1] };
};

const applyLink = (root: object, operation: LinkMutation, handle: Handle): void => {
	const path = operation.path;
	const ref = operation.ref;

	if (path.length === 0) throw linkError(path, ref, "does not resolve to a supported operation address");

	const resolved = nodeOfInternedId(handle, ref);

	if (resolved === undefined) throw linkError(path, ref, "does not resolve");

	const terminal = resolveTerminal(root, path);

	if (Array.isArray(terminal.parent) && terminal.segment === "length") {
		throw linkError(path, ref, "cannot address array length");
	}

	const key = requirePlainSegment(terminal.parent, terminal.segment, path);
	const descriptor = Reflect.getOwnPropertyDescriptor(terminal.parent, key);
	const present = descriptor !== undefined && descriptor.enumerable && "value" in descriptor;

	if (descriptor !== undefined && !present) throw unresolvedError(path);

	if (!present) {
		const inheritedDescriptor = getInheritedDescriptor(terminal.parent, key);

		if (inheritedDescriptor && !("value" in inheritedDescriptor)) {
			throw new Error(`opshot: ${formatOperationPath(path)} resolves to an inherited accessor`);
		}
	}

	Reflect.set(terminal.parent, key, resolved);
};

const applyPlain = (
	parent: object,
	segment: unknown,
	operation: Exclude<Mutation, LinkMutation>,
	identity: "restore" | "construct",
	handle: Handle,
): void => {
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

	restoreValue(
		getValuePayload(operation, identity),
		(value) => Reflect.set(parent, key, value),
		() => Reflect.get(parent, key),
		identity,
	);

	const attached: unknown = Reflect.get(parent, key);

	if (isObjectLike(attached)) internSubtree(handle, attached);
};

const applyMutation = (root: object, operation: Mutation, identity: "restore" | "construct", handle: Handle): void => {
	if (operation.verb === "link") {
		applyLink(root, operation, handle);

		return;
	}

	const terminal = resolveTerminal(root, operation.path);

	applyPlain(terminal.parent, terminal.segment, operation, identity, handle);
};

export function applyMutations(
	root: object,
	operations: ReadonlyArray<Operation>,
	direction: ApplyDirection,
	identity: "restore" | "construct",
	handle: Handle,
): void {
	if (direction === "do") {
		for (const operation of operations) applyMutation(root, operation.do, identity, handle);

		return;
	}

	for (let index = operations.length - 1; index >= 0; index--) {
		const operation = operations[index];

		if (operation === undefined) continue;

		applyMutation(root, operation.undo, identity, handle);
	}
}
