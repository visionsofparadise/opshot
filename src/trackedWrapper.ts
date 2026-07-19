import { toPointer, type Op, type PatchOperation } from "./diff";

export const trackedBrand: unique symbol = Symbol.for("opshot.tracked");

export type WrapperPatch = { readonly op: "add" | "replace"; readonly value: unknown } | { readonly op: "remove" };

export interface WrapperPayload {
	readonly do: WrapperPatch;
	readonly undo: WrapperPatch;
}

export interface WrapperCommand {
	readonly path: ReadonlyArray<string>;
	readonly payload: WrapperPayload;
}

export interface WrapperAttachment {
	readonly notify: (commandOp: unknown) => void;
}

const attachments = new WeakMap<object, Set<WrapperAttachment>>();

// Non-enumerable and on the prototype, so {...wrapper} never copies the brand; isTrackedWrapper
// reads through the prototype chain via Reflect.get.
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

const isWrapperPatch = (value: unknown): value is WrapperPatch => {
	if (typeof value !== "object" || value === null) return false;

	const op: unknown = Reflect.get(value, "op");

	return op === "add" || op === "replace" || op === "remove";
};

const isWrapperPayload = (value: unknown): value is WrapperPayload =>
	typeof value === "object" && value !== null && isWrapperPatch(Reflect.get(value, "do")) && isWrapperPatch(Reflect.get(value, "undo"));

export const isWrapperCommand = (value: unknown): value is WrapperCommand => {
	if (typeof value !== "object" || value === null) return false;

	const path: unknown = Reflect.get(value, "path");

	if (!Array.isArray(path) || !path.every((segment) => typeof segment === "string")) return false;

	return isWrapperPayload(Reflect.get(value, "payload"));
};

const withPointer = (patch: WrapperPatch, path: string): PatchOperation => (patch.op === "remove" ? { op: "remove", path } : { op: patch.op, path, value: patch.value });

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
