import { cloneValue } from "./cloneValue";
import { createOperationPath, type OperationPath } from "./path";
import type { Handle } from "../handle";

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

	/**
	 * Intern ids minted at admission for this assigned tree; apply binds the ids the op carries.
	 */
	readonly ids?: ReadonlyArray<number>;
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
 * Links the interned node `ref` into `path`.
 *
 * @example
 * { verb: "link", path: ["alias"], ref: 0 }
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
	 * Intern id of the node to link.
	 */
	readonly ref: number;
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

class AssignHalf extends OperationHalf {
	readonly verb = "assign";
	readonly value: unknown;
	readonly ids?: ReadonlyArray<number>;

	constructor(
		path: OperationPath,
		value: unknown,
		original: unknown = value,
		ids?: ReadonlyArray<number>,
		handle?: Handle,
	) {
		super(path);
		valueOriginals.set(this, original);
		this.value = cloneValue(value, new WeakMap(), this.path, handle);

		if (ids !== undefined) this.ids = ids;
	}
}

class DeleteHalf extends OperationHalf {
	readonly verb = "delete";
}

class LinkHalf extends OperationHalf {
	readonly verb = "link";
	readonly ref: number;

	constructor(path: OperationPath, ref: number) {
		super(path);
		this.ref = ref;
	}
}

export const stampOf = (operation: object): object | undefined => {
	const value: unknown = Object.getOwnPropertyDescriptor(operation, "stamp")?.value;

	return typeof value === "object" && value !== null ? value : undefined;
};

export const versionOf = (operation: object): number | undefined => {
	const value: unknown = Reflect.get(operation, "version");

	return typeof value === "number" && Number.isInteger(value) ? value : undefined;
};

export const stampOperation = (handle: Handle, operation: Operation): void => {
	handle.version += 1;
	Object.defineProperty(operation, "stamp", { value: handle.stamp, enumerable: false });
	Object.defineProperty(operation, "version", { value: handle.version, enumerable: true });
};

export const isMutation = (value: unknown): value is Mutation =>
	typeof value === "object" && value !== null && operationBrand in value;

export const getValueOriginal = (half: object): unknown => valueOriginals.get(half);

/**
 * Creates an assign half. `ids` are intern ids minted at admission for this assigned tree; apply binds the ids the op carries.
 *
 * @param path - Path to assign.
 * @param value - Value to assign.
 * @param original - Identity original, defaulting to `value`.
 * @param ids - Intern ids this half carries for the assigned tree.
 * @returns The assign half.
 */
export const createAssignMutation = (
	path: OperationPath,
	value: unknown,
	original: unknown = value,
	ids?: ReadonlyArray<number>,
	handle?: Handle,
): AssignMutation => new AssignHalf(path, value, original, ids, handle);

export const createDeleteMutation = (path: OperationPath): DeleteMutation => new DeleteHalf(path);

export const createLinkMutation = (path: OperationPath, ref: number): LinkMutation => new LinkHalf(path, ref);
