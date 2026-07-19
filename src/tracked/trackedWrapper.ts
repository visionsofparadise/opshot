import {
	createDateSetOperation,
	createMapDeleteOperation,
	createMapEntriesOperation,
	createMapSetOperation,
	createSetAddOperation,
	createSetDeleteOperation,
	createSetEntriesOperation,
	type Op,
	type Operation,
} from "../ops/operation";
import { toPointer } from "../ops/pointer";

export const trackedBrand: unique symbol = Symbol.for("opshot.tracked");

export type WrapperOperation =
	| { readonly kind: "mapSet"; readonly key: unknown; readonly value: unknown }
	| { readonly kind: "mapDelete"; readonly key: unknown }
	| { readonly kind: "mapEntries"; readonly entries: ReadonlyArray<readonly [unknown, unknown]> }
	| { readonly kind: "setAdd"; readonly member: unknown }
	| { readonly kind: "setDelete"; readonly member: unknown }
	| { readonly kind: "setEntries"; readonly members: ReadonlyArray<unknown> }
	| { readonly kind: "dateSet"; readonly epoch: number };

export interface WrapperPayload {
	readonly do: WrapperOperation;
	readonly undo: WrapperOperation;
}

export interface WrapperCommand {
	readonly path: ReadonlyArray<string>;
	readonly payload: WrapperPayload;
}

export interface WrapperAttachment {
	readonly notify: (commandOp: unknown) => void;
}

const attachments = new WeakMap<object, Set<WrapperAttachment>>();

export const brandTrackedPrototype = (prototype: object): void => {
	Object.defineProperty(prototype, trackedBrand, { value: true, enumerable: false, configurable: false, writable: false });
};

export const isTrackedWrapper = (value: unknown): value is object => typeof value === "object" && value !== null && Reflect.get(value, trackedBrand) === true;

export const attach = (wrapper: object, attachment: WrapperAttachment): void => {
	let set = attachments.get(wrapper);

	if (!set) {
		set = new Set();
		attachments.set(wrapper, set);
	}

	set.add(attachment);
};

export const getAttachments = (wrapper: object): Set<WrapperAttachment> | undefined => {
	const set = attachments.get(wrapper);

	return set !== undefined && set.size > 0 ? set : undefined;
};

export const notifyAttachments = (set: Set<WrapperAttachment>, command: WrapperCommand): void => {
	for (const attachment of set) attachment.notify(command);
};

export const wrapperOpTag = "opshot-wrapper";

const wrapperOperationKinds: ReadonlySet<string> = new Set(["mapSet", "mapDelete", "mapEntries", "setAdd", "setDelete", "setEntries", "dateSet"]);

const isWrapperOperation = (value: unknown): value is WrapperOperation => {
	if (typeof value !== "object" || value === null) return false;

	const kind: unknown = Reflect.get(value, "kind");

	return typeof kind === "string" && wrapperOperationKinds.has(kind);
};

const isWrapperPayload = (value: unknown): value is WrapperPayload =>
	typeof value === "object" && value !== null && isWrapperOperation(Reflect.get(value, "do")) && isWrapperOperation(Reflect.get(value, "undo"));

export const isWrapperCommand = (value: unknown): value is WrapperCommand => {
	if (typeof value !== "object" || value === null) return false;

	const path: unknown = Reflect.get(value, "path");

	if (!Array.isArray(path) || !path.every((segment) => typeof segment === "string")) return false;

	return isWrapperPayload(Reflect.get(value, "payload"));
};

const withPointer = (operation: WrapperOperation, path: string): Operation => {
	switch (operation.kind) {
		case "mapSet":
			return createMapSetOperation(path, operation.key, operation.value);
		case "mapDelete":
			return createMapDeleteOperation(path, operation.key);
		case "mapEntries":
			return createMapEntriesOperation(path, operation.entries);
		case "setAdd":
			return createSetAddOperation(path, operation.member);
		case "setDelete":
			return createSetDeleteOperation(path, operation.member);
		case "setEntries":
			return createSetEntriesOperation(path, operation.members);
		case "dateSet":
			return createDateSetOperation(path, operation.epoch);
	}
};

export interface WrapperNotification {
	readonly payload: WrapperPayload;
	readonly op: Op;
}

export const parseWrapperNotification = (entry: unknown): WrapperNotification | undefined => {
	if (!Array.isArray(entry) || entry[0] !== wrapperOpTag) return undefined;

	const path: unknown = entry[1];
	const payload: unknown = entry[2];

	if (!Array.isArray(path) || !path.every((segment): segment is string => typeof segment === "string")) return undefined;
	if (!isWrapperPayload(payload)) return undefined;

	const pointer = toPointer(path);

	return { payload, op: { isPatch: true, do: withPointer(payload.do, pointer), undo: withPointer(payload.undo, pointer) } };
};
