import { useEffect, useReducer, useState } from "react";
import { getVersion, subscribe as valtioSubscribe } from "valtio/vanilla";
import { createMutableState } from "../createMutableState";
import { createBoundary, type Boundary } from "./boundary";
import type { Group } from "../createGroup";

interface MutableStateHolder<T extends object> {
	readonly proxy: T;
	readonly boundary: Boundary;
}

export function useMutableState<T extends object>(properties: T, group?: Group): T {
	const [{ proxy, boundary }] = useState((): MutableStateHolder<T> => ({
		proxy: createMutableState(properties, group),
		boundary: createBoundary(),
	}));
	const [, bump] = useReducer((value: number) => value + 1, 0);
	const versionAtRender = getVersion(proxy);

	boundary.resetReads();

	const wrapper = boundary.wrap(proxy);

	useEffect(() => {
		const onSignal = (): void => {
			boundary.evictChangedTargets();

			if (boundary.readsChanged(proxy)) bump();
		};

		const unsubscribe = valtioSubscribe(proxy, onSignal, true);

		if (getVersion(proxy) !== versionAtRender) onSignal();

		return unsubscribe;
	}, [proxy, boundary, versionAtRender]);

	return wrapper;
}
