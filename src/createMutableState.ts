import { proxy } from "valtio/vanilla";
import { getGroupListeners, type Group } from "./createGroup";
import { mintGroupedEmitter } from "./emit/emitterBare";
import { stampSettings, type StateSettings } from "./settings";
import { assertSafeDataPaths, installBoundary } from "./valtio/boundary";
import { registerTrackedRoot } from "./valtio/constructorPathGuard";

export interface MutableStateOptions extends StateSettings {
	readonly group?: Group;
}

export function createMutableState<T extends object>(properties: T, options?: MutableStateOptions): T {
	installBoundary();

	assertSafeDataPaths(properties, [], new WeakSet(), options?.strict !== false);

	const base = Object.create(Reflect.getPrototypeOf(properties)) as T;

	Object.defineProperties(base, Object.getOwnPropertyDescriptors(properties));

	stampSettings(base, options);

	const proxied = proxy(base);

	registerTrackedRoot(base);

	if (options?.group !== undefined) {
		mintGroupedEmitter(proxied, getGroupListeners(options.group));
	}

	return proxied;
}
