import { isObjectLike } from "./utils/predicates";

const metaStack: Array<unknown> = [];

export function currentMeta(): unknown {
	return metaStack.length === 0 ? undefined : metaStack[metaStack.length - 1];
}

const isThenable = (value: unknown): value is PromiseLike<unknown> =>
	isObjectLike(value) && "then" in value && typeof value.then === "function";

/**
 * Runs writes carrying `meta`.
 * A callback that returns a promise throws: the meta covers only what runs before its first await.
 *
 * @param callback - Function that writes any states.
 * @param meta - Carried by each write's operation.
 */
// eslint-disable-next-line @typescript-eslint/no-invalid-void-type
export function batch(callback: () => void | undefined, meta?: unknown): void {
	metaStack.push(meta);

	let result: unknown;

	try {
		result = callback();
	} finally {
		metaStack.pop();
	}

	if (isThenable(result))
		throw new TypeError("opshot: batch requires a synchronous callback; writes after an await would carry no meta");
}
