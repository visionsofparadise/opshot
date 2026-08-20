/**
 * Schedules when bare writes notify listeners. Call `flush` once.
 *
 * @param flush - Delivers pending ops.
 * @returns Nothing.
 */
export type EmissionScheduler = (flush: () => void) => void;

/**
 * State creation options.
 *
 * @example
 * createMutableState({ x: 0 }, { emitOn: (flush) => requestAnimationFrame(flush), strict: false })
 */
export interface MutableNodeOptions {
	/**
	 * When bare writes notify listeners. Defaults to a microtask.
	 */
	readonly emitOn?: EmissionScheduler;

	/**
	 * When true, throws at a dangerous edge, at the cause. Defaults to true.
	 */
	readonly strict?: boolean;
}
