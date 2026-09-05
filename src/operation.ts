interface OperationBase<M> {
	/**
	 * Node that changed; writes through it are tracked.
	 */
	readonly node: Record<string, unknown>;
	/**
	 * Key that changed.
	 */
	readonly key: string;
	/**
	 * Meta of the batch the write was made in.
	 */
	readonly meta: M;
}

export interface AddOperation<M = unknown> extends OperationBase<M> {
	/**
	 * The key was absent before.
	 */
	readonly kind: "add";
	/**
	 * Value after.
	 */
	readonly after: unknown;
}

export interface ChangeOperation<M = unknown> extends OperationBase<M> {
	/**
	 * The key held a value before and after.
	 */
	readonly kind: "change";
	/**
	 * Value before.
	 */
	readonly before: unknown;
	/**
	 * Value after.
	 */
	readonly after: unknown;
}

export interface DeleteOperation<M = unknown> extends OperationBase<M> {
	/**
	 * The key is absent after.
	 */
	readonly kind: "delete";
	/**
	 * Value before.
	 */
	readonly before: unknown;
}

/**
 * A change to one key of a node.
 *
 * @example
 * { kind: "change", node, key: "count", before: 0, after: 1, meta: undefined }
 */
export type Operation<M = unknown> = AddOperation<M> | ChangeOperation<M> | DeleteOperation<M>;
