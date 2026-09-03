const metaStack: Array<unknown> = [];

export function currentMeta(): unknown {
	return metaStack.length === 0 ? undefined : metaStack[metaStack.length - 1];
}

/**
 * Runs writes carrying `meta`.
 *
 * @param callback - Function that writes any states.
 * @param meta - Carried by each write's operation.
 */
export function batch(callback: () => void, meta?: unknown): void {
	metaStack.push(meta);

	try {
		callback();
	} finally {
		metaStack.pop();
	}
}
