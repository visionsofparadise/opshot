import { unstable_getInternalStates } from "valtio/vanilla";

/**
 * Schedules when bare writes notify listeners. Call `flush` once.
 *
 * Governs bare writes only. A `transact` delivers synchronously and ignores this.
 * Invoked once per window, a microtask after the first write of a burst.
 *
 * @param flush - Delivers pending ops.
 * @returns Nothing.
 */
export type EmitOn = (flush: () => void) => void;

/**
 * State creation options.
 *
 * @example
 * createMutableState({ x: 0 }, { emitOn: (flush) => requestAnimationFrame(flush), strict: false })
 */
export interface StateSettings {
	/**
	 * When bare writes notify listeners. Defaults to a microtask.
	 * A `transact` delivers synchronously regardless.
	 */
	readonly emitOn?: EmitOn;

	/**
	 * When false, tracks values that would otherwise be rejected. Defaults to true.
	 */
	readonly strict?: boolean;
}

const settingsByTarget = new WeakMap<object, StateSettings>();

const { proxyStateMap } = unstable_getInternalStates();

export function stampSettings(target: object, settings: StateSettings | undefined): void {
	if (settings === undefined) return;

	const { emitOn, strict } = settings;

	if (emitOn === undefined && strict === undefined) return;

	const stamped: StateSettings =
		emitOn === undefined ? { strict } : strict === undefined ? { emitOn } : { emitOn, strict };

	settingsByTarget.set(target, stamped);
}

export function getSettings(target: object): StateSettings | undefined {
	return settingsByTarget.get(target);
}

export function inheritSettings(parentTarget: object, childTarget: object): void {
	const parent = settingsByTarget.get(parentTarget);

	if (parent === undefined) return;

	if (proxyStateMap.has(childTarget)) return;

	settingsByTarget.set(childTarget, parent);
}
