import { unstable_getInternalStates } from "valtio/vanilla";
import { handleOf } from "../handle";
import { walkDataEntries } from "../utils/dataEntries";
import { admissionLane } from "../valtio/classify";
import { isPlainArray } from "./cloneValue";
import { createOperationPath, type OperationPath } from "./path";
import { isCanonicalArrayIndexString } from "./predicates";

const { proxyStateMap } = unstable_getInternalStates();

const rawTargetOf = (value: object): object => proxyStateMap.get(value)?.[0] ?? value;

const possiblyShared = new WeakSet<object>();

export const flagPossiblyShared = (node: object): void => {
	possiblyShared.add(rawTargetOf(node));
};

export const isPossiblyShared = (node: object): boolean => possiblyShared.has(rawTargetOf(node));

const segmentFor = (parent: object, key: string): string | number =>
	isPlainArray(parent) && isCanonicalArrayIndexString(key) ? Number(key) : key;

interface InEdge {
	readonly parentLive: object;
	readonly segment: string | number;
}

export interface RouteIndex {
	readonly routesOf: (live: object) => ReadonlyArray<OperationPath>;
	readonly sharedLives: ReadonlySet<object>;
}

const NO_ROUTES: ReadonlyArray<OperationPath> = [];

export const createRouteIndex = (root: object): RouteIndex => {
	const inEdges = new Map<object, Array<InEdge>>();
	const expanded = new Set<object>();
	const firstRouteMemo = new Map<object, OperationPath>();
	const routesMemo = new Map<object, ReadonlyArray<OperationPath>>();
	const shared = new Set<object>();
	const handle = handleOf(root);
	const publishedOrigin = rawTargetOf(root);
	const publishedFromHandle: unknown = handle !== undefined ? handle.proxy.root : undefined;
	const publishedOriginTracked =
		handle !== undefined
			? typeof publishedFromHandle === "object" &&
				publishedFromHandle !== null &&
				admissionLane(publishedFromHandle) !== "untracked"
			: admissionLane(root) !== "untracked";

	const visit = (node: object): void => {
		const live = rawTargetOf(node);

		if (handle !== undefined && live === rawTargetOf(handle.proxy)) {
			const published: unknown = (node as { root: unknown }).root;

			if (typeof published === "object" && published !== null && admissionLane(published) !== "untracked") {
				visit(published);
			}

			return;
		}

		if (expanded.has(live)) return;

		expanded.add(live);

		for (const entry of walkDataEntries(node)) {
			const child: unknown = entry.value;

			if (typeof child !== "object" || child === null) continue;

			if (admissionLane(child) === "untracked") continue;

			const childLive = rawTargetOf(child);
			const segment = segmentFor(node, entry.key);
			const edges = inEdges.get(childLive);

			if (edges === undefined) {
				inEdges.set(childLive, [{ parentLive: live, segment }]);
			} else {
				edges.push({ parentLive: live, segment });

				if (edges.length === 2) shared.add(childLive);
			}

			visit(child);
		}
	};

	if (handle !== undefined) {
		visit(handle.proxy);
	} else if (publishedOriginTracked) {
		visit(root);
	}

	const firstRouteOf = (live: object): OperationPath => {
		if (live === publishedOrigin && publishedOriginTracked) return createOperationPath([]);

		const memoized = firstRouteMemo.get(live);

		if (memoized !== undefined) return memoized;

		const first = inEdges.get(live)?.[0];
		const route =
			first === undefined
				? createOperationPath([])
				: createOperationPath([...firstRouteOf(first.parentLive), first.segment]);

		firstRouteMemo.set(live, route);

		return route;
	};

	return {
		routesOf: (live: object): ReadonlyArray<OperationPath> => {
			const key = rawTargetOf(live);
			const memoized = routesMemo.get(key);

			if (memoized !== undefined) return memoized;

			if (key === publishedOrigin) {
				if (!publishedOriginTracked) {
					routesMemo.set(key, NO_ROUTES);

					return NO_ROUTES;
				}

				const originEdges = inEdges.get(key) ?? [];
				const routes = [
					createOperationPath([]),
					...originEdges.map((edge) => createOperationPath([...firstRouteOf(edge.parentLive), edge.segment])),
				];

				routesMemo.set(key, routes);

				return routes;
			}

			const edges = inEdges.get(key);

			if (edges === undefined || edges.length === 0) {
				routesMemo.set(key, NO_ROUTES);

				return NO_ROUTES;
			}

			const routes = edges.map((edge, index) =>
				index === 0 ? firstRouteOf(key) : createOperationPath([...firstRouteOf(edge.parentLive), edge.segment]),
			);

			routesMemo.set(key, routes);

			return routes;
		},
		sharedLives: shared,
	};
};

export const routeUnderPath = (route: OperationPath, formation: OperationPath): boolean => {
	if (route.length < formation.length) return false;

	for (let index = 0; index < formation.length; index++) {
		const routeSegment = route[index];
		const formationSegment = formation[index];

		if (routeSegment === undefined || formationSegment === undefined) return false;

		if (routeSegment !== formationSegment) return false;
	}

	return true;
};

export const externalRoutesOf = (
	routes: ReadonlyArray<OperationPath>,
	formation: OperationPath,
): ReadonlyArray<OperationPath> => routes.filter((route) => !routeUnderPath(route, formation));

export const canonicalRouteOf = (routes: ReadonlyArray<OperationPath>): OperationPath | undefined => routes[0];
