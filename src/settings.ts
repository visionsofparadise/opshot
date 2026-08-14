import { unstable_getInternalStates } from "valtio/vanilla";

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
	 * When false, tracks values that would otherwise be rejected. Defaults to true.
	 */
	readonly strict?: boolean;
}

const optionsByTarget = new WeakMap<object, MutableNodeOptions>();

const { proxyStateMap } = unstable_getInternalStates();

export function stampOptions(target: object, options: MutableNodeOptions | undefined): void {
	if (options === undefined) return;

	const { emitOn, strict } = options;

	if (emitOn === undefined && strict === undefined) return;

	const stamped: MutableNodeOptions =
		emitOn === undefined ? { strict } : strict === undefined ? { emitOn } : { emitOn, strict };

	optionsByTarget.set(target, stamped);
}

export function getOptions(target: object): MutableNodeOptions | undefined {
	return optionsByTarget.get(target);
}

export function inheritOptions(parentTarget: object, childTarget: object): void {
	const parent = optionsByTarget.get(parentTarget);

	if (parent === undefined) return;

	if (proxyStateMap.has(childTarget)) return;

	optionsByTarget.set(childTarget, parent);
}
