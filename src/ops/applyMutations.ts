import { handleOf, handlesOf, type Handle } from "../handle";
import { getRegisteredTarget, resolveIdentity } from "../identity";
import { walkDataEntries } from "../utils/dataEntries";
import { cloneValue } from "./cloneValue";
import { getValueOriginal, type AssignMutation, type LinkMutation, type Mutation, type Operation } from "./operation";
import { createOperationPath, formatOperationPath, type OperationPath } from "./path";
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

const unresolvedError = (path: OperationPath): Error =>
	new Error(`opshot: ${formatOperationPath(path)} does not resolve to a supported operation address`);

const linkError = (path: OperationPath, ref: OperationPath, reason: string): Error =>
	new Error(`opshot: link at ${formatOperationPath(path)} with ref ${formatOperationPath(ref)} ${reason}`);

const isWritableDataDescriptor = (descriptor: PropertyDescriptor | undefined): boolean =>
	descriptor !== undefined && "value" in descriptor && descriptor.writable === true;

const isAdmittedOn = (destination: Handle | undefined, node: object): boolean => {
	if (destination === undefined) return true;

	return handlesOf(node).includes(destination);
};

const restoreRecordedContent = (
	attached: object,
	recorded: object,
	restored: WeakSet<object>,
	destination: Handle | undefined,
): void => {
	if (restored.has(recorded)) return;

	restored.add(recorded);

	for (const entry of walkDataEntries(recorded, true)) {
		const key = entry.key;
		const attachedDescriptor = Reflect.getOwnPropertyDescriptor(attached, key);

		if (attachedDescriptor !== undefined && !isWritableDataDescriptor(attachedDescriptor)) continue;

		const value: unknown = entry.value;

		if (isObjectLike(value)) {
			const target = getRegisteredTarget(value);

			if (target !== undefined && isAdmittedOn(destination, target)) {
				const present: unknown = attachedDescriptor?.value;

				if (!isObjectLike(present) || resolveIdentity(present) !== resolveIdentity(target)) {
					Reflect.set(attached, key, target);
				}

				const child: unknown = Reflect.get(attached, key);

				if (!isObjectLike(child)) throw new Error(`opshot: replay could not reattach ${key}`);

				restoreRecordedContent(child, value, restored, destination);

				continue;
			}

			if (target !== undefined) {
				Reflect.set(attached, key, cloneValue(value, new WeakMap(), createOperationPath([])));

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
	const original = getValueOriginal(operation) ?? operation.value;

	return {
		recorded: original,
		fallback: isObjectLike(original) ? cloneValue(original, new WeakMap(), operation.path) : original,
	};
};

const restoreValue = (
	payload: ValuePayload,
	attach: (value: unknown) => void,
	readAttached: () => unknown,
	destination: Handle | undefined,
): void => {
	if (isObjectLike(payload.recorded)) {
		const target = getRegisteredTarget(payload.recorded);

		if (target !== undefined && isAdmittedOn(destination, target)) {
			attach(target);

			const attached = readAttached();

			if (!isObjectLike(attached)) throw new Error("opshot: replay could not read a reattached target");

			restoreRecordedContent(attached, payload.recorded, new WeakSet(), destination);

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

export const resolveRefValue = (root: object, ref: OperationPath, linkPath: OperationPath): object => {
	if (ref.length === 0) return root;

	let current: unknown = root;

	for (let index = 0; index < ref.length; index++) {
		if (!isObjectLike(current)) throw linkError(linkPath, ref, "does not resolve");

		try {
			current = requirePlainProperty(current, ref[index], ref);
		} catch {
			throw linkError(linkPath, ref, "does not resolve");
		}
	}

	if (!isObjectLike(current)) throw linkError(linkPath, ref, "resolves to a non-object");

	return current;
};

const applyLink = (root: object, operation: LinkMutation): void => {
	const path = operation.path;
	const ref = operation.ref;

	if (path.length === 0) throw linkError(path, ref, "does not resolve to a supported operation address");

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

	Reflect.set(terminal.parent, key, resolveRefValue(root, ref, path));
};

const applyPlain = (
	parent: object,
	segment: unknown,
	operation: Exclude<Mutation, LinkMutation>,
	destination: Handle | undefined,
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

	if (!("value" in operation)) throw unresolvedError(path);

	restoreValue(
		getValuePayload(operation),
		(value) => Reflect.set(parent, key, value),
		() => Reflect.get(parent, key),
		destination,
	);
};

const applyMutation = (root: object, operation: Mutation, destination: Handle | undefined): void => {
	if (operation.verb === "link") {
		applyLink(root, operation);

		return;
	}

	const terminal = resolveTerminal(root, operation.path);

	applyPlain(terminal.parent, terminal.segment, operation, destination);
};

export function applyMutations(root: object, operations: ReadonlyArray<Operation>, direction: ApplyDirection): void {
	const destination = handleOf(root);

	if (direction === "do") {
		for (const operation of operations) applyMutation(root, operation.do, destination);

		return;
	}

	for (let index = operations.length - 1; index >= 0; index--) {
		const operation = operations[index];

		if (operation === undefined) continue;

		applyMutation(root, operation.undo, destination);
	}
}
