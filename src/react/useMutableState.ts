import { useEffect, useReducer, useRef, useState } from "react";
import { createMutableState, type MutableStateOptions } from "../createMutableState";
import { handlesOf, proxyOf } from "../node";
import { subscribe } from "../subscribe";
import { createReadTracker, readsIntersectDirty, type ReadTracker } from "./readTracker";
import { useCommitEffect } from "./useCommitEffect";
import type { Handle } from "../handle";

interface MutableStateHolder<T> {
	readonly writeProxy: T;
	readonly readTracker: ReadTracker;
}

const isObjectLike = (value: unknown): value is object =>
	value !== null && (typeof value === "object" || typeof value === "function");

/**
 * Creates mutable state for a component.
 *
 * @typeParam T - State shape.
 * @param properties - Initial fields, or a function that returns them.
 * @param options - Creation options.
 * @returns The state.
 */
export function useMutableState<T extends object>(properties: (() => T) | T, options?: MutableStateOptions): T {
	const [{ writeProxy, readTracker }] = useState((): MutableStateHolder<T> => {
		const initial = typeof properties === "function" ? properties() : properties;

		return {
			writeProxy: createMutableState(initial, options),
			readTracker: createReadTracker(),
		};
	});
	const [, bump] = useReducer((value: number) => value + 1, 0);
	const currentHandlesRef = useRef<ReadonlyArray<Handle>>([]);
	const uniqueHandles = isObjectLike(writeProxy) ? handlesOf(writeProxy) : [];

	readTracker.resetReads();

	const readProxy = isObjectLike(writeProxy) ? readTracker.wrap(writeProxy) : writeProxy;

	useCommitEffect(() => {
		currentHandlesRef.current = uniqueHandles;
		readTracker.captureReads();
	});

	useEffect(() => {
		readTracker.retain();

		return () => readTracker.dispose();
	}, [readTracker]);

	useEffect(() => {
		let cancelled = false;
		const subscribedHandles = isObjectLike(writeProxy) ? handlesOf(writeProxy) : [];

		const unsubscribes = subscribedHandles.map((handle) =>
			subscribe(proxyOf(handle.root), () => {
				if (cancelled) return;

				const dirty = handle.lastDirty;

				if (dirty !== undefined && readsIntersectDirty(readTracker, dirty)) bump();
			}),
		);

		return () => {
			cancelled = true;

			for (const unsubscribe of unsubscribes) unsubscribe();
		};
	}, [writeProxy, readTracker]);

	return readProxy;
}
