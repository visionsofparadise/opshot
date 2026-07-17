import { createProxy, isChanged } from "proxy-compare";
import { memo, useCallback, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type FC } from "react";
import { snapshot as valtioSnapshot, subscribe as valtioSubscribe } from "valtio/vanilla";
import { createGroup, type Group } from "./createGroup";
import { createState, isState, type Define, type State } from "./createState";

type PropPath = Array<string | number>;

function shouldTraverse(value: unknown): boolean {
	if (value === null || typeof value !== "object") return false;
	if (Array.isArray(value)) return true;

	const prototype: unknown = Object.getPrototypeOf(value);

	return prototype === Object.prototype || prototype === null;
}

function findSnapshotPaths(value: unknown, path: PropPath = [], paths: Array<PropPath> = []): Array<PropPath> {
	if (isState(value)) {
		paths.push(path);

		return paths;
	}

	if (!shouldTraverse(value)) return paths;

	if (Array.isArray(value)) {
		value.forEach((item, index) => {
			findSnapshotPaths(item, [...path, index], paths);
		});
	} else {
		for (const [key, propertyValue] of Object.entries(value as object)) {
			if (key === "children") continue;

			findSnapshotPaths(propertyValue, [...path, key], paths);
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

function useResnapshotAll(snapshots: Array<State<object>>): Array<object> {
	const lastRendered = useRef<Array<object>>([]);
	const lastReturned = useRef<Array<object>>([]);

	const nextProxies = snapshots.map((snap) => snap.op.proxy);
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

	const freshSnapshots = useSyncExternalStore(subscribe, getSnapshot);

	useLayoutEffect(() => {
		lastRendered.current = freshSnapshots;
	});

	const trackedSnapshots = useMemo(
		() =>
			freshSnapshots.map((snap, index) => {
				const tracking = trackings[index];

				if (!tracking) return snap;

				return createProxy(snap, tracking.affected, tracking.proxyCache, targetCache);
			}),
		[freshSnapshots, trackings],
	);

	return isStale ? snapshots : trackedSnapshots;
}

export function resnapshot<P extends object>(component: FC<P>): FC<P> {
	const componentName = component.displayName ?? component.name;

	const Resnapshotted: FC<P> = (props) => {
		const snapshotPaths = useMemo(() => findSnapshotPaths(props), [props]);
		const staleSnapshots = useMemo(() => snapshotPaths.map((path) => getAtPath(props, path)).filter(isState), [props, snapshotPaths]);
		const freshSnapshots = useResnapshotAll(staleSnapshots);

		const freshProps = useMemo(() => {
			if (freshSnapshots === staleSnapshots) return props;

			return snapshotPaths.reduce<P>((acc, path, index) => setAtPath(acc, path, freshSnapshots[index]), props);
		}, [props, snapshotPaths, staleSnapshots, freshSnapshots]);

		return component(freshProps);
	};

	Resnapshotted.displayName = `resnapshot(${componentName === "" ? "Anonymous" : componentName})`;

	return memo(Resnapshotted);
}

export const useCreateGroup = (): Group => useState(() => createGroup())[0];

export const useCreateState = <T extends object>(define: Define<T>, group?: Group): State<T> => {
	const created = useState(() => (group ? group.createState(define) : createState(define)))[0];
	const [fresh] = useResnapshotAll([created]);

	return fresh as State<T>;
};
