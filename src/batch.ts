const metaStack: Array<unknown> = [];

export function currentMeta(): unknown {
	return metaStack.length === 0 ? undefined : metaStack[metaStack.length - 1];
}

/**
 * Runs writes in one batch and notifies listeners with optional `meta`.
 *
 * @param callback - Function that writes any states.
 * @param meta - Passed to listeners.
 * @returns Nothing.
 */
export function batch(callback: () => void, meta?: unknown): void {
	metaStack.push(meta);

	try {
		callback();
	} finally {
		metaStack.pop();
	}
}
