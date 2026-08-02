import { useEffect, useReducer, useState } from "react";
import { getVersion, subscribe as valtioSubscribe } from "valtio/vanilla";
import { createMutableState, type MutableStateOptions } from "../createMutableState";
import { createBoundary, type Boundary } from "./boundary";
import { useCommitEffect } from "./useCommitEffect";

interface MutableStateHolder<T extends object> {
	readonly proxy: T;
	readonly boundary: Boundary;
}

/**
 * Creates mutable state for a component.
 *
 * @typeParam T - State shape.
 * @param properties - Initial fields, or a function that returns them.
 * @param options - Creation options.
 * @returns The state.
 */
export function useMutableState<T extends object>(properties: (() => T) | T, options?: MutableStateOptions): T {
	const [{ proxy, boundary }] = useState((): MutableStateHolder<T> => ({
		proxy: createMutableState(typeof properties === "function" ? properties() : properties, options),
		boundary: createBoundary(),
	}));
	const [, bump] = useReducer((value: number) => value + 1, 0);
	const versionAtRender = getVersion(proxy);

	boundary.resetReads();

	const wrapper = boundary.wrap(proxy);

	useCommitEffect(() => {
		boundary.captureReads();
	});

	useEffect(() => {
		boundary.retain();

		return () => boundary.dispose();
	}, [boundary]);

	useEffect(() => {
		const onSignal = (): void => {
			if (boundary.readsChanged(proxy)) bump();
		};

		return valtioSubscribe(proxy, onSignal, true);
	}, [proxy, boundary]);

	useEffect(() => {
		if (getVersion(proxy) === versionAtRender) return;

		if (boundary.readsChanged(proxy)) bump();
	});

	return wrapper;
}
