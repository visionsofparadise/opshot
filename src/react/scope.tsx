import { createElement, memo, useEffect, useReducer, useRef, type ComponentType, type FC } from "react";
import { getVersion, subscribe as valtioSubscribe } from "valtio/vanilla";
import { isSameIdentity } from "../identity";
import { isState } from "../isState";
import { addressOf } from "../tracked/address";
import { substituteStates } from "./propWalk";
import { createReadTracker, type ReadTracker } from "./readTracker";
import { useCommitEffect } from "./useCommitEffect";

const sourcesKey = (sources: ReadonlyArray<object>): string =>
	`${sources.length}:${sources.map((source) => addressOf(source)).join(",")}`;

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

		readTrackerRef.current ??= createReadTracker();

		const readTracker = readTrackerRef.current;
		const [, bump] = useReducer((value: number) => value + 1, 0);

		readTracker.resetReads();

		const { props: renderedProps, sources } = substituteStates(props, (source) => readTracker.wrap(source));
		const versionsAtRender = sources.map((source) => getVersion(source));

		useCommitEffect(() => {
			readTracker.captureReads();
		});

		useEffect(() => {
			readTracker.retain();

			return () => readTracker.dispose();
		}, [readTracker]);

		useEffect(() => {
			const unsubscribes = sources.map((source) =>
				valtioSubscribe(
					source,
					() => {
						if (readTracker.readsChanged(source)) bump();
					},
					true,
				),
			);

			return () => {
				for (const unsubscribe of unsubscribes) unsubscribe();
			};
		}, [sourcesKey(sources), readTracker]);

		useEffect(() => {
			let shouldBump = false;

			for (let index = 0; index < sources.length; index += 1) {
				const source = sources[index];
				const captured = versionsAtRender[index];

				if (source === undefined || captured === undefined) continue;

				if (getVersion(source) !== captured) {
					if (readTracker.readsChanged(source)) shouldBump = true;
				}
			}

			if (shouldBump) bump();
		});

		return createElement(Component, renderedProps);
	};

	const baseName: unknown = Component.displayName ?? Component.name;

	Scoped.displayName = `scope(${typeof baseName === "string" && baseName !== "" ? baseName : "Component"})`;

	return memo(Scoped, arePropsEqual);
}
