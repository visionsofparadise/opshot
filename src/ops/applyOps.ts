import type { State } from "../createState";
import { getRegisteredTarget, resolveIdentity } from "../identity";
import { setTrackedDateEpoch } from "../tracked/trackedDate";
import { bumpTrackedMapEpoch, getTrackedMapData } from "../tracked/trackedMap";
import { bumpTrackedSetEpoch, getTrackedSetData } from "../tracked/trackedSet";
import { isTrackedWrapper } from "../tracked/trackedWrapper";
import { getValueOriginal, isOperation, type AddOperation, type Operation, type ReplaceOperation } from "./operation";
import { formatOperationPath, getPathSelector, type OperationPath } from "./path";

type ValueOperation = Extract<AddOperation, { readonly value: unknown }> | ReplaceOperation;
type FacadeKind = "TrackedMap" | "TrackedSet" | "TrackedDate";

interface ValuePayload {
	readonly recorded: unknown;
	readonly fallback: unknown;
}

interface ResolvedTerminal {
	readonly parent: object;
	readonly segment: unknown;
	readonly kind: "plain" | "map" | "set" | "date";
}

const isObjectLike = (value: unknown): value is object => value !== null && (typeof value === "object" || typeof value === "function");
const sameValueZero = (first: unknown, second: unknown): boolean => first === second || (first !== first && second !== second);
const sameIdentity = (first: unknown, second: unknown): boolean => sameValueZero(resolveIdentity(first), resolveIdentity(second));

const assertApplicable: (operation: unknown) => asserts operation is Operation = (operation) => {
	if (typeof operation === "object" && operation !== null && "isPatch" in operation) {
		throw new Error("opshot: applyOps applies operation halves; pass op.do or op.undo.");
	}

	if (!isOperation(operation)) {
		throw new Error("opshot: this op is a copy (spread, JSON, or structuredClone) and has lost its value. Apply the op objects the listener delivered; never copy them.");
	}
};

const getFacadeKind = (target: unknown): FacadeKind | undefined => {
	if (!isTrackedWrapper(target)) return undefined;

	const tag: unknown = Reflect.get(target, Symbol.toStringTag);

	if (tag === "TrackedMap" || tag === "TrackedSet" || tag === "TrackedDate") return tag;

	return undefined;
};

const assertSafePath = (path: OperationPath): void => {
	for (let index = 0; index < path.length; index++) {
		const segment = path[index];

		if (segment === "__proto__" || (segment === "prototype" && path[index - 1] === "constructor")) {
			throw new Error(`opshot: reserved operation path ${formatOperationPath(path)}`);
		}
	}
};

const unresolvedError = (path: OperationPath): Error => new Error(`opshot: ${formatOperationPath(path)} does not resolve to a supported operation address`);
const unresolvedSlotError = (path: OperationPath, slot: number): Error => new Error(`opshot: ${formatOperationPath(path)} cannot restore collection slot ${slot}`);

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
	const orderedKeys = Array.isArray(recorded) ? ["length", ...recordedKeys.filter((key) => key !== "length")] : recordedKeys;

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
		if (isObjectLike(original) && getRegisteredTarget(original) !== undefined) return { recorded: original, fallback: undefined };

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

const isCanonicalArrayIndex = (segment: unknown): segment is number => Number.isInteger(segment) && typeof segment === "number" && segment >= 0 && segment < 4_294_967_295;
const isCanonicalArrayIndexString = (segment: string): boolean => {
	const index = Number(segment);

	return Number.isInteger(index) && index >= 0 && index < 4_294_967_295 && String(index) === segment;
};

const requirePlainProperty = (parent: object, segment: unknown, path: OperationPath): unknown => {
	if (Array.isArray(parent)) {
		if (segment === "length") return parent.length;
		if (!isCanonicalArrayIndex(segment) && (typeof segment !== "string" || isCanonicalArrayIndexString(segment))) throw unresolvedError(path);
	} else if (typeof segment !== "string") {
		throw unresolvedError(path);
	}

	const descriptor = Reflect.getOwnPropertyDescriptor(parent, segment);

	if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) throw unresolvedError(path);

	return Reflect.get(parent, segment);
};

const selectorValue = (segment: unknown): { readonly kind: "keyOf" | "valueOf" | "raw"; readonly value: unknown } => {
	const selector = getPathSelector(segment);

	return selector ?? { kind: "raw", value: segment };
};

const findMapEntry = (facade: object, key: unknown): { readonly slot: number; readonly key: unknown; readonly value: unknown } | undefined => {
	const data = getTrackedMapData(facade);

	for (let slot = 0; slot < data.length; slot++) {
		const entry = data[slot];

		if (entry && sameIdentity(entry[0], key)) return { slot, key: entry[0], value: entry[1] };
	}

	return undefined;
};

const findSetEntry = (facade: object, member: unknown): { readonly slot: number; readonly member: unknown } | undefined => {
	const data = getTrackedSetData(facade);

	for (let slot = 0; slot < data.length; slot++) {
		const entry = data[slot];

		if (entry && sameIdentity(entry[0], member)) return { slot, member: entry[0] };
	}

	return undefined;
};

const resolveTraversalSegment = (parent: unknown, segment: unknown, path: OperationPath): unknown => {
	if (!isObjectLike(parent)) throw unresolvedError(path);

	const kind = getFacadeKind(parent);

	if (kind === "TrackedMap") {
		const selector = selectorValue(segment);
		const entry = findMapEntry(parent, selector.value);

		if (!entry) throw unresolvedError(path);

		return selector.kind === "keyOf" ? entry.key : entry.value;
	}

	if (kind === "TrackedSet") {
		const selector = selectorValue(segment);

		if (selector.kind === "keyOf") throw unresolvedError(path);

		const entry = findSetEntry(parent, selector.value);

		if (!entry) throw unresolvedError(path);

		return entry.member;
	}

	if (kind === "TrackedDate") throw unresolvedError(path);

	return requirePlainProperty(parent, segment, path);
};

const resolveTerminal = (root: object, path: OperationPath): ResolvedTerminal => {
	assertSafePath(path);

	if (path.length === 0) throw new Error("opshot: root operations are not supported");

	let parent: unknown = root;

	for (let index = 0; index < path.length - 1; index++) parent = resolveTraversalSegment(parent, path[index], path);

	if (!isObjectLike(parent)) throw unresolvedError(path);

	const segment = path[path.length - 1];
	const facadeKind = getFacadeKind(parent);

	if (facadeKind === "TrackedMap") return { parent, segment, kind: "map" };
	if (facadeKind === "TrackedSet") return { parent, segment, kind: "set" };
	if (facadeKind === "TrackedDate") return { parent, segment, kind: "date" };

	return { parent, segment, kind: "plain" };
};

const applyPlain = (parent: object, segment: unknown, operation: Operation): void => {
	const path = operation.path;

	if (Array.isArray(parent) && segment === "length") {
		if (operation.op !== "replace" || typeof operation.value !== "number" || !Number.isInteger(operation.value) || operation.value < 0 || operation.value > 4_294_967_295) {
			throw unresolvedError(path);
		}

		setOrThrow(parent, "length", operation.value);

		return;
	}

	if (Array.isArray(parent)) {
		if (!isCanonicalArrayIndex(segment) && (typeof segment !== "string" || isCanonicalArrayIndexString(segment))) throw unresolvedError(path);
	} else if (typeof segment !== "string") {
		throw unresolvedError(path);
	}

	const descriptor = Reflect.getOwnPropertyDescriptor(parent, segment);
	const present = descriptor !== undefined && descriptor.enumerable && "value" in descriptor;

	if (descriptor !== undefined && !present) throw unresolvedError(path);
	if (operation.op === "add" && present) throw unresolvedError(path);
	if (operation.op !== "add" && !present) throw unresolvedError(path);

	if (operation.op === "add") {
		const inheritedDescriptor = getInheritedDescriptor(parent, segment);

		if (inheritedDescriptor && !("value" in inheritedDescriptor)) {
			throw new Error(`opshot: ${formatOperationPath(path)} resolves to an inherited accessor`);
		}
	}

	if (operation.op === "remove") {
		deleteOrThrow(parent, segment);

		return;
	}

	if (!("value" in operation)) throw unresolvedError(path);

	restoreValue(
		getValuePayload(operation),
		(value) => setOrThrow(parent, segment, value),
		() => Reflect.get(parent, segment),
	);
};

const restoreMapAddition = (facade: object, operation: AddOperation, key: unknown): void => {
	if (!("value" in operation) || !("slot" in operation) || typeof operation.slot !== "number") throw unresolvedError(operation.path);

	const data = getTrackedMapData(facade);

	while (data.length < operation.slot) data.push(null);

	const existing = data[operation.slot];

	if (operation.slot !== data.length && existing !== null) throw unresolvedSlotError(operation.path, operation.slot);

	const recordedKey = selectorValue(operation.path[operation.path.length - 1]).value;
	const registeredKey = isObjectLike(recordedKey) ? getRegisteredTarget(recordedKey) : undefined;
	const attachedKey = registeredKey ?? resolveIdentity(key);

	restoreValue(
		getValuePayload(operation),
		(value) => {
			data[operation.slot] = [attachedKey, value];
		},
		() => data[operation.slot]?.[1],
	);

	const restoredKey = data[operation.slot]?.[0];

	if (registeredKey !== undefined && isObjectLike(recordedKey) && isObjectLike(restoredKey)) {
		restoreRecordedContent(restoredKey, recordedKey, new WeakSet());
	}

	bumpTrackedMapEpoch(facade);
};

const applyMap = (facade: object, segment: unknown, operation: Operation): void => {
	const selector = selectorValue(segment);

	if (selector.kind === "keyOf") throw unresolvedError(operation.path);

	const entry = findMapEntry(facade, selector.value);

	if (operation.op === "add") {
		if (entry) throw unresolvedError(operation.path);

		restoreMapAddition(facade, operation, selector.value);

		return;
	}

	if (!entry) throw unresolvedError(operation.path);

	const data = getTrackedMapData(facade);

	if (operation.op === "remove") {
		data[entry.slot] = null;
		bumpTrackedMapEpoch(facade);

		return;
	}

	restoreValue(
		getValuePayload(operation),
		(value) => {
			data[entry.slot] = [entry.key, value];
		},
		() => data[entry.slot]?.[1],
	);
	bumpTrackedMapEpoch(facade);
};

const applySet = (facade: object, segment: unknown, operation: Operation): void => {
	const selector = selectorValue(segment);

	if (selector.kind === "keyOf" || operation.op === "replace") throw unresolvedError(operation.path);

	const entry = findSetEntry(facade, selector.value);

	if (operation.op === "remove") {
		if (!entry) throw unresolvedError(operation.path);

		getTrackedSetData(facade)[entry.slot] = null;
		bumpTrackedSetEpoch(facade);

		return;
	}

	if (entry || "value" in operation || !("slot" in operation) || typeof operation.slot !== "number") throw unresolvedError(operation.path);

	const data = getTrackedSetData(facade);

	while (data.length < operation.slot) data.push(null);

	const existing = data[operation.slot];

	if (operation.slot !== data.length && existing !== null) throw unresolvedSlotError(operation.path, operation.slot);

	const recorded = selector.value;
	const registered = isObjectLike(recorded) ? getRegisteredTarget(recorded) : undefined;
	const member = registered ?? resolveIdentity(recorded);

	data[operation.slot] = [member];

	const restoredMember = data[operation.slot]?.[0];

	if (registered !== undefined && isObjectLike(recorded) && isObjectLike(restoredMember)) {
		restoreRecordedContent(restoredMember, recorded, new WeakSet());
	}

	bumpTrackedSetEpoch(facade);
};

const applyDate = (facade: object, segment: unknown, operation: Operation): void => {
	if (segment !== "epoch" || operation.op !== "replace" || typeof operation.value !== "number") {
		throw unresolvedError(operation.path);
	}

	setTrackedDateEpoch(facade, operation.value);
};

const applyOperations = (root: object, operations: ReadonlyArray<Operation>): void => {
	for (const operation of operations) {
		const terminal = resolveTerminal(root, operation.path);

		switch (terminal.kind) {
			case "plain":
				applyPlain(terminal.parent, terminal.segment, operation);
				break;
			case "map":
				applyMap(terminal.parent, terminal.segment, operation);
				break;
			case "set":
				applySet(terminal.parent, terminal.segment, operation);
				break;
			case "date":
				applyDate(terminal.parent, terminal.segment, operation);
				break;
		}
	}
};

export function applyOps<T extends object, In extends object = {}, Out extends object = {}>(
	state: State<T, In, Out>,
	operations: ReadonlyArray<Operation>,
	...meta: {} extends In ? [meta?: In] : [meta: In]
): void {
	for (const operation of operations) assertApplicable(operation);

	state.mutate((mutable) => {
		applyOperations(mutable, operations);
	}, ...meta);
}
