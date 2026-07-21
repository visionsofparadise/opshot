import { cloneValue, isCloneable } from "./cloneValue";
import { createOperationPath, type OperationPath } from "./path";

export type AddOperation =
	| { readonly op: "add"; readonly path: OperationPath; readonly value: unknown }
	| { readonly op: "add"; readonly path: OperationPath; readonly value: unknown; readonly slot: number }
	| { readonly op: "add"; readonly path: OperationPath; readonly slot: number };

export interface ReplaceOperation { readonly op: "replace"; readonly path: OperationPath; readonly value: unknown }
export interface RemoveOperation { readonly op: "remove"; readonly path: OperationPath }
export type Operation = AddOperation | ReplaceOperation | RemoveOperation;

export interface Op { readonly isPatch: true; readonly do: Operation; readonly undo: Operation }

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

class AddHalf extends ValueHalf {
	readonly op = "add";
}

class SlottedAddHalf extends ValueHalf {
	readonly op = "add";
	readonly slot: number;

	constructor(path: OperationPath, value: unknown, slot: number) {
		super(path, value);
		this.slot = slot;
	}
}

class MembershipAddHalf extends OperationHalf {
	readonly op = "add";
	readonly slot: number;

	constructor(path: OperationPath, slot: number) {
		super(path);
		this.slot = slot;
	}
}

class ReplaceHalf extends ValueHalf {
	readonly op = "replace";
}

class RemoveHalf extends OperationHalf {
	readonly op = "remove";
}

export const isOperation = (value: unknown): value is Operation => typeof value === "object" && value !== null && operationBrand in value;

export const getValueOriginal = (half: object): unknown => valueOriginals.get(half);

export const createAddOperation = (path: OperationPath, value: unknown, slot?: number): AddOperation =>
	slot === undefined ? new AddHalf(path, value) : new SlottedAddHalf(path, value, slot);

export const createMembershipAddOperation = (path: OperationPath, slot: number): AddOperation => new MembershipAddHalf(path, slot);

export const createReplaceOperation = (path: OperationPath, value: unknown): ReplaceOperation => new ReplaceHalf(path, value);

export const createRemoveOperation = (path: OperationPath): RemoveOperation => new RemoveHalf(path);
