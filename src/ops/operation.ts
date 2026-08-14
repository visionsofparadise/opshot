import { cloneValue } from "./cloneValue";
import { createOperationPath, type OperationPath } from "./path";

/**
 * Assigns a value at a path.
 *
 * @example
 * { verb: "assign", path: ["count"], value: 1 }
 */
export interface AssignMutation {
	/**
	 * `"assign"`.
	 */
	readonly verb: "assign";

	/**
	 * Path to assign.
	 */
	readonly path: OperationPath;

	/**
	 * Value to assign.
	 */
	readonly value: unknown;
}

/**
 * Deletes the value at a path.
 *
 * @example
 * { verb: "delete", path: ["temp"] }
 */
export interface DeleteMutation {
	/**
	 * `"delete"`.
	 */
	readonly verb: "delete";

	/**
	 * Path to delete.
	 */
	readonly path: OperationPath;
}

/**
 * Links the node at `ref` into `path`.
 *
 * @example
 * { verb: "link", path: ["alias"], ref: ["shared"] }
 */
export interface LinkMutation {
	/**
	 * `"link"`.
	 */
	readonly verb: "link";

	/**
	 * Path to place the linked node.
	 */
	readonly path: OperationPath;

	/**
	 * Path of the node to link.
	 */
	readonly ref: OperationPath;
}

/**
 * An assign, a delete, or a link.
 *
 * @example
 * { verb: "assign", path: ["profile"], value: { name: "Ada" } }
 */
export type Mutation = AssignMutation | DeleteMutation | LinkMutation;

/**
 * A change with do and undo halves.
 *
 * @example
 * { do: { verb: "assign", path: ["count"], value: 1 }, undo: { verb: "assign", path: ["count"], value: 0 } }
 */
export interface Operation {
	/**
	 * Forward operation.
	 */
	readonly do: Mutation;

	/**
	 * Reverse operation.
	 */
	readonly undo: Mutation;
}

const operationBrand = Symbol.for("opshot.operation");
const valueOriginals = new WeakMap<object, unknown>();

abstract class OperationHalf {
	abstract readonly verb: Mutation["verb"];
	readonly path: OperationPath;

	constructor(path: OperationPath) {
		this.path = createOperationPath(path);
	}
}

Object.defineProperty(OperationHalf.prototype, operationBrand, { value: true });

abstract class ValueHalf extends OperationHalf {
	get value(): unknown {
		return cloneValue(valueOriginals.get(this), new WeakMap(), this.path);
	}

	constructor(path: OperationPath, value: unknown) {
		super(path);
		valueOriginals.set(this, value);
	}
}

class AssignHalf extends ValueHalf {
	readonly verb = "assign";
}

class DeleteHalf extends OperationHalf {
	readonly verb = "delete";
}

class LinkHalf extends OperationHalf {
	readonly verb = "link";
	readonly ref: OperationPath;

	constructor(path: OperationPath, ref: OperationPath) {
		super(path);
		this.ref = createOperationPath(ref);
	}
}

export const isMutation = (value: unknown): value is Mutation =>
	typeof value === "object" && value !== null && operationBrand in value;

export const getValueOriginal = (half: object): unknown => valueOriginals.get(half);

export const createAssignMutation = (path: OperationPath, value: unknown): AssignMutation =>
	new AssignHalf(path, value);

export const createDeleteMutation = (path: OperationPath): DeleteMutation => new DeleteHalf(path);

export const createLinkMutation = (path: OperationPath, ref: OperationPath): LinkMutation => new LinkHalf(path, ref);
