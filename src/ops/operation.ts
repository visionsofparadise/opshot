import { cloneValue, isCloneable } from "./cloneValue";
import { createOperationPath, type OperationPath } from "./path";

/**
 * Assigns a value at a path.
 *
 * @example
 * { op: "assign", path: ["count"], value: 1 }
 */
export interface AssignOperation {
	/**
	 * `"assign"`.
	 */
	readonly op: "assign";

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
 * { op: "delete", path: ["temp"] }
 */
export interface DeleteOperation {
	/**
	 * `"delete"`.
	 */
	readonly op: "delete";

	/**
	 * Path to delete.
	 */
	readonly path: OperationPath;
}

/**
 * An assign or delete operation.
 *
 * @example
 * { op: "assign", path: ["profile"], value: { name: "Ada" } }
 */
export type Operation = AssignOperation | DeleteOperation;

/**
 * A change with do and undo halves.
 *
 * @example
 * { do: { op: "assign", path: ["count"], value: 1 }, undo: { op: "assign", path: ["count"], value: 0 } }
 */
export interface Op {
	/**
	 * Forward operation.
	 */
	readonly do: Operation;

	/**
	 * Reverse operation.
	 */
	readonly undo: Operation;
}

const operationBrand = Symbol.for("opshot.operation");
const valueOriginals = new WeakMap<object, unknown>();

abstract class OperationHalf {
	abstract readonly op: Operation["op"];
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

		if (!isCloneable(value)) Object.defineProperty(this, "value", { value, enumerable: true });
	}
}

class AssignHalf extends ValueHalf {
	readonly op = "assign";
}

class DeleteHalf extends OperationHalf {
	readonly op = "delete";
}

export const isOperation = (value: unknown): value is Operation =>
	typeof value === "object" && value !== null && operationBrand in value;

export const getValueOriginal = (half: object): unknown => valueOriginals.get(half);

export const createAssignOperation = (path: OperationPath, value: unknown): AssignOperation =>
	new AssignHalf(path, value);

export const createDeleteOperation = (path: OperationPath): DeleteOperation => new DeleteHalf(path);
