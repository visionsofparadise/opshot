import { useEffect, useReducer, useState } from "react";
import { createMutableState, type MutableStateOptions } from "../createMutableState";
import { emitWrites } from "../emit/emitter";
import { lastDeliveryDirty } from "../emit/emitterDeliver";
import { handlesOf } from "../handle";
import { subscribe } from "../subscribe";
import { createReadTracker, readsIntersectDirty, type ReadTracker } from "./readTracker";
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
	const uniqueHandles = handlesOf(writeProxy);
	const dirtyAtRender = uniqueHandles.map((handle) => handle.lastDirty);

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
		let cancelled = false;
		const subscribedHandles = handlesOf(writeProxy);

		for (const handle of subscribedHandles) {
			if (handle.hasPendingWrites && handle.emitOn === undefined) emitWrites(handle);
		}

		const unsubscribes = subscribedHandles.map((handle) =>
			subscribe(handle.proxy.root, () => {
				if (cancelled) return;

				const dirty = lastDeliveryDirty(handle);

				if (dirty !== undefined && readsIntersectDirty(readTracker, dirty)) bump();
			}),
		);

		return () => {
			cancelled = true;

			for (const unsubscribe of unsubscribes) unsubscribe();
		};
	}, [writeProxy, readTracker]);

	useEffect(() => {
		let shouldBump = false;

		for (let index = 0; index < uniqueHandles.length; index += 1) {
			const handle = uniqueHandles[index];
			const captured = dirtyAtRender[index];

			if (handle === undefined) continue;

			const current = handle.lastDirty;

			if (current === undefined || current === captured) continue;

			if (readsIntersectDirty(readTracker, current)) shouldBump = true;
		}

		if (shouldBump) bump();
	});

	return readProxy;
}
