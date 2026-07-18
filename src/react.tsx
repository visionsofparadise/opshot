import { createProxy, isChanged } from "proxy-compare";
import { memo, useCallback, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type FC } from "react";
import { snapshot as valtioSnapshot, subscribe as valtioSubscribe } from "valtio/vanilla";
import { createGroup, type Group } from "./createGroup";
import { createGroupState, isMeta, isState, type Define, type Meta, type State } from "./createState";

type PropPath = Array<string | number>;

function shouldTraverse(value: unknown): boolean {
	if (value === null || typeof value !== "object") return false;
	if (Array.isArray(value)) return true;

	const prototype: unknown = Object.getPrototypeOf(value);

	return prototype === Object.prototype || prototype === null;
}

function findStatePaths(value: unknown, path: PropPath = [], paths: Array<PropPath> = []): Array<PropPath> {
	if (isState(value)) {
		paths.push(path);

		return paths;
	}

	if (!shouldTraverse(value)) return paths;

	if (Array.isArray(value)) {
		value.forEach((item, index) => {
			findStatePaths(item, [...path, index], paths);
		});
	} else {
		for (const [key, propertyValue] of Object.entries(value as object)) {
			if (key === "children") continue;

			findStatePaths(propertyValue, [...path, key], paths);
		}
	}

	return paths;
}

function getAtPath(object: unknown, path: PropPath): unknown {
	let current = object;

	for (const segment of path) {
		if (current === null || current === undefined) return undefined;

		current = (current as Record<string | number, unknown>)[segment];
	}

	return current;
}

function setAtPath<T>(object: T, path: PropPath, value: unknown): T {
	if (path.length === 0) return value as T;

	const head = path[0];

	if (head === undefined) throw new Error("setAtPath: non-empty path yielded no head segment");

	const tail = path.slice(1);
	const current = (object as Record<string | number, unknown>)[head];
	const updated = setAtPath(current, tail, value);

	if (Array.isArray(object)) {
		const clone = [...object];

		clone[head as number] = updated;

		return clone as T;
	}

	return { ...object, [head]: updated };
}

interface Tracking {
	affected: WeakMap<object, unknown>;
	proxyCache: WeakMap<object, unknown>;
}

const targetCache = new WeakMap<object, unknown>();

function useRetrackAll(states: Array<{ readonly op: { readonly unsafeMutable: object } }>): Array<object> {
	const lastRendered = useRef<Array<object>>([]);
	const lastReturned = useRef<Array<object>>([]);

	const nextProxies = states.map((state) => state.op.unsafeMutable);
	const [proxies, setProxies] = useState(nextProxies);

	const isStale = proxies.length !== nextProxies.length || proxies.some((proxied, index) => proxied !== nextProxies[index]);

	if (isStale) setProxies(nextProxies);

	const trackings = useMemo(() => proxies.map((): Tracking => ({ affected: new WeakMap(), proxyCache: new WeakMap() })), [proxies]);

	const getSnapshot = useCallback((): Array<object> => {
		const next = proxies.map((proxied) => valtioSnapshot(proxied));
		const last = lastReturned.current;

		if (last.length === next.length && last.every((snap, index) => snap === next[index])) return last;

		lastReturned.current = next;

		return next;
	}, [proxies]);

	const subscribe = useCallback(
		(callback: () => void) => {
			const unsubscribes = proxies.map((proxied, index) =>
				valtioSubscribe(proxied, () => {
					const prev = lastRendered.current[index];
					const tracking = trackings[index];

					if (prev && tracking && prev !== valtioSnapshot(proxied)) {
						if (!tracking.affected.has(prev)) return;

						try {
							if (!isChanged(prev, valtioSnapshot(proxied), tracking.affected, new WeakMap())) return;
						} catch {
							// isChanged over exotic values falls back to notifying
						}
					}

					callback();
				}),
			);

			return () => {
				for (const unsubscribe of unsubscribes) unsubscribe();
			};
		},
		[proxies, trackings],
	);

	const freshStates = useSyncExternalStore(subscribe, getSnapshot);

	useLayoutEffect(() => {
		lastRendered.current = freshStates;
	});

	const trackedSnapshots = useMemo(
		() =>
			freshStates.map((snap, index) => {
				const tracking = trackings[index];

				if (!tracking) return snap;

				return createProxy(snap, tracking.affected, tracking.proxyCache, targetCache);
			}),
		[freshStates, trackings],
	);

	return isStale ? states : trackedSnapshots;
}

export function retrack<P extends object>(component: FC<P>): FC<P> {
	const componentName = component.displayName ?? component.name;

	const Retracked: FC<P> = (props) => {
		const snapshotPaths = useMemo(() => findStatePaths(props), [props]);
		const staleStates = useMemo(() => snapshotPaths.map((path) => getAtPath(props, path)).filter(isState), [props, snapshotPaths]);
		const freshStates = useRetrackAll(staleStates);

		const freshProps = useMemo(() => {
			if (freshStates === staleStates) return props;

			return snapshotPaths.reduce<P>((acc, path, index) => setAtPath(acc, path, freshStates[index]), props);
		}, [props, snapshotPaths, staleStates, freshStates]);

		return component(freshProps);
	};

	Retracked.displayName = `retrack(${componentName === "" ? "Anonymous" : componentName})`;

	return memo(Retracked);
}

export function useGroup(): Group;
export function useGroup<In extends object, Out extends object>(meta: Meta<In, Out>): Group<In, Out>;
export function useGroup<In extends object, Out extends object>(meta?: Meta<In, Out>): Group<In, Out> {
	return useState(() => (meta === undefined ? createGroup() : createGroup(meta)) as Group<In, Out>)[0];
}

export function useTrackedState<T extends object>(define: Define<T>): State<T>;
export function useTrackedState<T extends object, In extends object, Out extends object>(define: Define<T, In, Out>, groupOrMeta: Group<In, Out> | Meta<In, Out>): State<T, In, Out>;
export function useTrackedState<T extends object, In extends object, Out extends object>(define: Define<T, In, Out>, groupOrMeta?: Group<In, Out> | Meta<In, Out>): State<T, In, Out> {
	const created = useState(() => {
		if (groupOrMeta !== undefined && !isMeta(groupOrMeta)) return (groupOrMeta as Group<In, Out>).createState(define);

		return createGroupState(define, undefined, groupOrMeta as Meta<In, Out> | undefined);
	})[0];
	const [fresh] = useRetrackAll([created]);

	return fresh as State<T, In, Out>;
}
