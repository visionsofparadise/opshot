import { createProxy, isChanged } from "proxy-compare";
import { memo, useCallback, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type FC } from "react";
import { snapshot as valtioSnapshot, subscribe as valtioSubscribe } from "valtio/vanilla";
import { classifyValue, constructorName } from "./boundary";
import { createGroup, type Group } from "./createGroup";
import { createGroupState, isMeta, isState, type Define, type Meta, type State } from "./createState";

type PropPath = Array<string | number | { readonly map: unknown } | { readonly set: number }>;

const isMap = (value: unknown): value is Map<unknown, unknown> => value instanceof Map;
const isSet = (value: unknown): value is Set<unknown> => value instanceof Set;

const isPlainPrototype = (value: object): boolean => {
	const prototype = Reflect.getPrototypeOf(value);

	return prototype === Object.prototype || prototype === null;
};

// Substituting a state clones each container along its path; Object.create + descriptors cannot carry
// #private fields or internal slots, and an array subclass rebuilds to a plain array, so the state's
// container would come back broken far from here. A clean class clones faithfully enough (the walk's
// "dumb and thorough" ruling), so it is allowed through.
const assertSubstitutableContainer = (container: object): void => {
	if (isPlainPrototype(container)) return;

	const kind = classifyValue(container);

	if (kind === "plain" || kind === "plainArray" || kind === "cleanClass") return;

	const className = constructorName(container.constructor);

	if (kind === "arraySubclass") {
		throw new Error(`opshot: retrack found a state inside ${className}, an array subclass whose prototype can't survive substitution. Move the state to a plain array, or ignore() the ${className}.`);
	}

	const hidden = kind === "privateClass" ? "private fields" : "internal slots";

	throw new Error(`opshot: retrack found a state inside ${className}, whose ${hidden} can't survive substitution. Move the state to a plain container, or ignore() the ${className}.`);
};

function findStatePaths(value: unknown, maxDepth: number, path: PropPath = [], paths: Array<PropPath> = [], ancestors = new Set<object>()): Array<PropPath> {
	if (isState(value)) {
		paths.push(path);

		return paths;
	}

	if (value === null || typeof value !== "object") return paths;
	if ("$$typeof" in value) return paths;
	if (ancestors.has(value)) return paths;
	if (path.length >= maxDepth) return paths;

	ancestors.add(value);

	if (Array.isArray(value)) {
		const foundCount = paths.length;

		value.forEach((item, index) => {
			findStatePaths(item, maxDepth, [...path, index], paths, ancestors);
		});

		if (paths.length > foundCount) assertSubstitutableContainer(value);
	} else if (isMap(value)) {
		for (const [key, entryValue] of value) findStatePaths(entryValue, maxDepth, [...path, { map: key }], paths, ancestors);
	} else if (isSet(value)) {
		let index = 0;

		for (const item of value) {
			findStatePaths(item, maxDepth, [...path, { set: index }], paths, ancestors);
			index += 1;
		}
	} else {
		const foundCount = paths.length;

		for (const [key, propertyValue] of Object.entries(value)) {
			// React stamps fiber references onto host DOM nodes under __react-prefixed expando keys;
			// descending one would drag the application's fiber graph into the walk.
			if (key.startsWith("__react")) continue;

			findStatePaths(propertyValue, maxDepth, [...path, key], paths, ancestors);
		}

		if (paths.length > foundCount) assertSubstitutableContainer(value);
	}

	ancestors.delete(value);

	return paths;
}

function getAtPath(object: unknown, path: PropPath): unknown {
	let current = object;

	for (const segment of path) {
		if (current === null || current === undefined) return undefined;

		if (typeof segment === "object") {
			if ("map" in segment) {
				current = isMap(current) ? current.get(segment.map) : undefined;
			} else {
				current = isSet(current) ? [...current][segment.set] : undefined;
			}
		} else {
			current = (current as Record<string | number, unknown>)[segment];
		}
	}

	return current;
}

function setAtPath<T>(object: T, path: PropPath, value: unknown): T {
	if (path.length === 0) return value as T;

	const head = path[0];

	if (head === undefined) throw new Error("setAtPath: non-empty path yielded no head segment");

	const tail = path.slice(1);

	if (typeof head === "object") {
		if ("map" in head) {
			if (!isMap(object)) throw new Error("opshot: retrack substitution expected a Map at a map path segment");

			const clone = new Map(object);

			clone.set(head.map, setAtPath(object.get(head.map), tail, value));

			return clone as T;
		}

		if (!isSet(object)) throw new Error("opshot: retrack substitution expected a Set at a set path segment");

		const clone = new Set<unknown>();
		let index = 0;

		for (const item of object) {
			clone.add(index === head.set ? setAtPath(item, tail, value) : item);
			index += 1;
		}

		return clone as T;
	}

	const current = (object as Record<string | number, unknown>)[head];
	const updated = setAtPath(current, tail, value);

	if (Array.isArray(object)) {
		const clone = [...object];

		clone[head as number] = updated;

		return clone as T;
	}

	const prototype = Reflect.getPrototypeOf(object as object);

	if (prototype === Object.prototype || prototype === null) return { ...object, [head]: updated };

	const descriptor = Object.getOwnPropertyDescriptor(object, head);

	if (descriptor?.get !== undefined || descriptor?.set !== undefined) {
		const className = constructorName((object as object).constructor);

		throw new Error(
			`opshot: retrack found a state behind the accessor "${String(head)}" on ${className}, which can't survive substitution. Move the state to a plain container, or ignore() the ${className}.`,
		);
	}

	const clone = Object.create(prototype) as Record<string | number, unknown>;

	Object.defineProperties(clone, Object.getOwnPropertyDescriptors(object as object));
	clone[head] = updated;

	return clone as T;
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

export interface RetrackOptions {
	readonly maxDepth?: number;
}

export function retrack<P extends object>(component: FC<P>, options?: RetrackOptions): FC<P> {
	const componentName = component.displayName ?? component.name;
	const maxDepth = options?.maxDepth ?? 10;

	const Retracked: FC<P> = (props) => {
		const snapshotPaths = useMemo(() => findStatePaths(props, maxDepth), [props]);
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
