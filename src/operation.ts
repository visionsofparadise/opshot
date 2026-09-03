/**
 * A change to one key of a node.
 *
 * @example
 * { node, key: "count", before: 0, after: 1, meta: undefined }
 */
export interface Operation {
	/**
	 * Node that changed.
	 */
	readonly node: object;
	/**
	 * Key that changed.
	 */
	readonly key: string;
	/**
	 * Value before, absent when the key was absent.
	 */
	readonly before?: unknown;
	/**
	 * Value after, absent when the key is absent.
	 */
	readonly after?: unknown;
	/**
	 * Meta of the batch the write was made in.
	 */
	readonly meta: unknown;
}
