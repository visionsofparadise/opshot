import { unstable_getInternalStates } from "valtio/vanilla";

export type EmitOn = (flush: () => void) => void;

export interface StateSettings {
	readonly emitOn?: EmitOn;
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
