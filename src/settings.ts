import { unstable_getInternalStates } from "valtio/vanilla";

/**
 * Schedules when bare writes notify listeners. Call `flush` once.
 *
 * Governs bare writes only. A `transact` delivers synchronously and ignores this.
 * Invoked once per window, a microtask after the first write of a burst.
 *
 * A pending flush pins its state until it runs, measured at about 380 KB for a
 * 200-row state, so a scheduler that discards the callback retains what it was given.
 *
 * @param flush - Delivers pending ops.
 * @returns Nothing.
 */
export type EmissionScheduler = (flush: () => void) => void;

/**
 * Options stamped onto a mutable node: emission scheduling and strictness.
 * Shared by root creation and `group.createMutableState`.
 *
 * @example
 * createMutableState({ x: 0 }, { emitOn: (flush) => requestAnimationFrame(flush), strict: false })
 */
export interface MutableNodeOptions {
	/**
	 * When bare writes notify listeners. Defaults to a microtask.
	 * A `transact` delivers synchronously regardless.
	 */
	readonly emitOn?: EmissionScheduler;

	/**
	 * When false, tracks values that would otherwise be rejected. Defaults to true.
	 * Graphs of differing strictness refuse to join: match this option on both sides, clone the
	 * value into the receiving state, or share it as `ignore()`.
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

export function restampOptions(target: object, options: MutableNodeOptions | undefined): void {
	if (options === undefined) {
		optionsByTarget.delete(target);

		return;
	}

	optionsByTarget.set(target, options);
}
