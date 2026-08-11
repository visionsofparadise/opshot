import { unstable_getInternalStates } from "valtio/vanilla";
import { walkDataEntries } from "../utils/dataEntries";
import { isPlainArray } from "./cloneValue";
import { createOperationPath, type OperationPath } from "./path";
import { isCanonicalArrayIndexString } from "./predicates";

const { proxyStateMap, refSet } = unstable_getInternalStates();

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
	readonly isReachable: (live: object) => boolean;
	readonly routesOf: (live: object) => ReadonlyArray<OperationPath>;
	readonly sharedLives: ReadonlySet<object>;
}

export const createRouteIndex = (root: object): RouteIndex => {
	const inEdges = new Map<object, Array<InEdge>>();
	const expanded = new Set<object>();
	const firstRouteMemo = new Map<object, OperationPath>();
	const shared = new Set<object>();
	const rootLive = rawTargetOf(root);

	inEdges.set(rootLive, []);

	const visit = (node: object): void => {
		const live = rawTargetOf(node);

		if (expanded.has(live)) return;

		expanded.add(live);

		for (const entry of walkDataEntries(node)) {
			const child: unknown = entry.value;

			if (typeof child !== "object" || child === null) continue;

			if (refSet.has(child)) continue;

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

	visit(root);

	const firstRouteOf = (live: object): OperationPath => {
		const memoized = firstRouteMemo.get(live);

		if (memoized !== undefined) return memoized;

		const edges = inEdges.get(live);

		if (edges === undefined || edges.length === 0) {
			const empty = createOperationPath([]);

			firstRouteMemo.set(live, empty);

			return empty;
		}

		const first = edges[0];

		if (first === undefined) {
			const empty = createOperationPath([]);

			firstRouteMemo.set(live, empty);

			return empty;
		}

		const route = createOperationPath([...firstRouteOf(first.parentLive), first.segment]);

		firstRouteMemo.set(live, route);

		return route;
	};

	return {
		isReachable: (live: object): boolean => inEdges.has(rawTargetOf(live)),
		routesOf: (live: object): ReadonlyArray<OperationPath> => {
			const key = rawTargetOf(live);
			const edges = inEdges.get(key);

			if (edges === undefined) return [];

			if (edges.length === 0) return [firstRouteOf(key)];

			return edges.map((edge, index) => {
				if (index === 0) return firstRouteOf(key);

				return createOperationPath([...firstRouteOf(edge.parentLive), edge.segment]);
			});
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
