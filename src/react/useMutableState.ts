import { useEffect, useReducer, useRef, useState } from "react";
import { snapshot } from "valtio/vanilla";
import { createMutableState, type MutableStateOptions, type Unmarked } from "../createMutableState";
import { handlesOf, type Handle } from "../handle";
import { subscribe } from "../subscribe";
import { dirtySinceSnapshot } from "./dirtySinceSnapshot";
import { createReadTracker, readsIntersectDirty, type ReadTracker } from "./readTracker";
import { useCommitEffect } from "./useCommitEffect";

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
export function useMutableState<T extends object>(
	properties: (() => T) | T,
	options?: MutableStateOptions,
): Unmarked<T> {
	const [{ writeProxy, readTracker }] = useState((): MutableStateHolder<Unmarked<T>> => {
		const initial = typeof properties === "function" ? properties() : properties;

		return {
			writeProxy: createMutableState(initial, options),
			readTracker: createReadTracker(),
		};
	});
	const [, bump] = useReducer((value: number) => value + 1, 0);
	const currentHandlesRef = useRef<ReadonlyArray<Handle>>([]);
	const [gapSnapshots] = useState(() => new WeakMap<Handle, object>());
	const uniqueHandles = isObjectLike(writeProxy) ? handlesOf(writeProxy) : [];

	readTracker.resetReads();

	const readProxy = isObjectLike(writeProxy) ? readTracker.wrap(writeProxy) : writeProxy;

	for (const handle of uniqueHandles) {
		gapSnapshots.set(handle, snapshot(handle.proxy.root));
	}

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

		for (const handle of subscribedHandles) {
			const from = gapSnapshots.get(handle);

			if (from !== undefined && readsIntersectDirty(readTracker, dirtySinceSnapshot(handle, from))) bump();
		}

		const unsubscribes = subscribedHandles.map((handle) =>
			subscribe(handle.proxy.root, () => {
				if (cancelled) return;

				const dirty = handle.lastDirty;

				if (dirty !== undefined && readsIntersectDirty(readTracker, dirty)) bump();
			}),
		);

		return () => {
			cancelled = true;

			const currentHandles = new Set(currentHandlesRef.current);

			for (const handle of subscribedHandles) {
				if (currentHandles.has(handle)) continue;

				gapSnapshots.set(handle, snapshot(handle.proxy.root));
			}

			for (const unsubscribe of unsubscribes) unsubscribe();
		};
	}, [writeProxy, readTracker]);

	return readProxy;
}
