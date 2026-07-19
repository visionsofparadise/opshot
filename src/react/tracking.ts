import { createProxy, isChanged } from "proxy-compare";
import { useCallback, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { snapshot as valtioSnapshot, subscribe as valtioSubscribe } from "valtio/vanilla";

interface Tracking {
	affected: WeakMap<object, unknown>;
	proxyCache: WeakMap<object, unknown>;
}

const targetCache = new WeakMap<object, unknown>();

export function useRetrackAll(states: Array<{ readonly op: { readonly unsafeMutable: object } }>): Array<object> {
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
