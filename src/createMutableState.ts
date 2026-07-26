import { proxy } from "valtio/vanilla";
import { getGroupListeners, type Group } from "./createGroup";
import { mintGroupedEmitter } from "./emitter";
import { assertSafeDataPaths, installBoundary } from "./valtio/boundary";
import { registerTrackedRoot } from "./valtio/constructorPathGuard";

export function createMutableState<T extends object>(properties: T, group?: Group): T {
	installBoundary();

	assertSafeDataPaths(properties);

	const base = Object.create(Reflect.getPrototypeOf(properties)) as T;

	Object.defineProperties(base, Object.getOwnPropertyDescriptors(properties));

	const proxied = proxy(base);

	registerTrackedRoot(base);

	if (group !== undefined) {
		mintGroupedEmitter(proxied, getGroupListeners(group));
	}

	return proxied;
}
