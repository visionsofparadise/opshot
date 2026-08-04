import { useEffect, useReducer, useState } from "react";
import { getVersion, subscribe as valtioSubscribe } from "valtio/vanilla";
import { createMutableState, type MutableStateOptions } from "../createMutableState";
import { createReadTracker, type ReadTracker } from "./readTracker";
import { useCommitEffect } from "./useCommitEffect";

interface MutableStateHolder<T extends object> {
	readonly writeProxy: T;
	readonly readTracker: ReadTracker;
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
	const [{ writeProxy, readTracker }] = useState((): MutableStateHolder<T> => ({
		writeProxy: createMutableState(typeof properties === "function" ? properties() : properties, options),
		readTracker: createReadTracker(),
	}));
	const [, bump] = useReducer((value: number) => value + 1, 0);
	const versionAtRender = getVersion(writeProxy);

	readTracker.resetReads();

	const readProxy = readTracker.wrap(writeProxy);

	useCommitEffect(() => {
		readTracker.captureReads();
	});

	useEffect(() => {
		readTracker.retain();

		return () => readTracker.dispose();
	}, [readTracker]);

	useEffect(() => {
		const onSignal = (): void => {
			if (readTracker.readsChanged(writeProxy)) bump();
		};

		return valtioSubscribe(writeProxy, onSignal, true);
	}, [writeProxy, readTracker]);

	useEffect(() => {
		if (getVersion(writeProxy) === versionAtRender) return;

		if (readTracker.readsChanged(writeProxy)) bump();
	});

	return readProxy;
}
