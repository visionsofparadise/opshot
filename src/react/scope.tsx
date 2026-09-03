import { createElement, memo, useEffect, useReducer, useRef, type ComponentType, type FC } from "react";
import { isSameIdentity } from "../identity";
import { isState } from "../isState";
import { handlesOf, proxyOf } from "../node";
import { subscribe } from "../subscribe";
import { addressOf } from "../tracked/address";
import { substituteStates } from "./propWalk";
import { createReadTracker, readsChanged, readsIntersectDirty, type ReadTracker } from "./readTracker";
import { useCommitEffect } from "./useCommitEffect";
import type { Handle } from "../handle";

const sourcesKey = (sources: ReadonlyArray<object>): string =>
	`${sources.length}:${sources.map((source) => addressOf(source)).join(",")}`;

const uniqueHandlesOf = (nodes: ReadonlyArray<object>): Array<Handle> => {
	const unique = new Array<Handle>();
	const seen = new Set<Handle>();

	for (const node of nodes) {
		for (const handle of handlesOf(node)) {
			if (seen.has(handle)) continue;

			seen.add(handle);
			unique.push(handle);
		}
	}

	return unique;
};

const arePropsEqual = (previous: object, next: object): boolean => {
	const previousRecord = previous as Record<string, unknown>;
	const nextRecord = next as Record<string, unknown>;
	const keys = Object.keys(previousRecord);

	if (keys.length !== Object.keys(nextRecord).length) return false;

	for (const key of keys) {
		const before = previousRecord[key];
		const after = nextRecord[key];

		if (Object.is(before, after)) continue;

		if (
			typeof before === "object" &&
			before !== null &&
			typeof after === "object" &&
			after !== null &&
			isState(before) &&
			isState(after) &&
			isSameIdentity(before, after)
		) {
			continue;
		}

		return false;
	}

	return true;
};

/**
 * Wraps a component so it re-renders only when fields it read change.
 *
 * @typeParam P - Props type.
 * @param Component - Component to wrap.
 * @returns The wrapped component.
 */
export function scope<P extends object>(Component: ComponentType<P>): FC<P> {
	const Scoped: FC<P> = (props) => {
		const readTrackerRef = useRef<ReadTracker | undefined>(undefined);
		const currentHandlesRef = useRef<ReadonlyArray<Handle>>([]);

		readTrackerRef.current ??= createReadTracker();

		const readTracker = readTrackerRef.current;
		const [, bump] = useReducer((value: number) => value + 1, 0);

		readTracker.resetReads();

		const { props: renderedProps, sources } = substituteStates(props, (source) => readTracker.wrap(source));
		const uniqueHandles = uniqueHandlesOf(sources);

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
			const subscribedHandles = uniqueHandlesOf(sources);

			const unsubscribes = subscribedHandles.map((handle) =>
				subscribe(proxyOf(handle.root), () => {
					if (cancelled) return;

					const dirty = handle.lastDirty;

					if (dirty !== undefined && readsIntersectDirty(readTracker, dirty)) bump();
				}),
			);

			if (readsChanged(readTracker)) bump();

			return () => {
				cancelled = true;

				for (const unsubscribe of unsubscribes) unsubscribe();
			};
		}, [sourcesKey(sources), readTracker]);

		return createElement(Component, renderedProps);
	};

	const baseName: unknown = Component.displayName ?? Component.name;

	Scoped.displayName = `scope(${typeof baseName === "string" && baseName !== "" ? baseName : "Component"})`;

	return memo(Scoped, arePropsEqual);
}
