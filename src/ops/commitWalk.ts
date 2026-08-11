import { unstable_getInternalStates } from "valtio/vanilla";
import { isStateRoot } from "../stateRoots";
import { walkDataEntries } from "../utils/dataEntries";
import { isPlainArray } from "./cloneValue";
import { createOperationPath, type OperationPath } from "./path";
import { isCanonicalArrayIndexString } from "./predicates";

const { proxyStateMap } = unstable_getInternalStates();

const rawTargetOf = (value: object): object => proxyStateMap.get(value)?.[0] ?? value;

const emptyFormationCandidates: ReadonlySet<object> = new Set();

let formationCandidatesByRoot = new WeakMap<object, Set<object>>();

let formationPulse = new Set<object>();

const bucketFor = (root: object): Set<object> => {
	const key = rawTargetOf(root);
	let bucket = formationCandidatesByRoot.get(key);

	if (bucket === undefined) {
		bucket = new Set();
		formationCandidatesByRoot.set(key, bucket);
	}

	return bucket;
};

/**
 * Flags an already-registered admitted node as a formation candidate for the commit walk.
 *
 * A state-root host records the candidate on that root's ledger immediately. A nested host
 * writes into a short-lived pulse; each armed emitter absorbs the pulse onto its root ledger when
 * valtio notifies the write, so multi-root sharing copies to every notified root and a deferred
 * `emitOn` on one state cannot clear another's ledger.
 *
 * @param node - Already-registered admitted value.
 * @param host - Container that received the write (root or nested raw/proxy target).
 * @returns Nothing.
 */
export const flagFormationCandidate = (node: object, host?: object): void => {
	const candidate = rawTargetOf(node);

	if (host !== undefined) {
		const liveHost = rawTargetOf(host);

		if (isStateRoot(liveHost)) {
			bucketFor(liveHost).add(candidate);

			return;
		}
	}

	formationPulse.add(candidate);
};

/**
 * Copies the current formation pulse onto a state's root ledger at notify time.
 *
 * @param root - State root (write proxy or raw target).
 * @returns Nothing.
 */
export const absorbFormationPulse = (root: object): void => {
	if (formationPulse.size === 0) return;

	const bucket = bucketFor(root);

	for (const candidate of formationPulse) bucket.add(candidate);
};

export const clearFormationPulse = (): void => {
	if (formationPulse.size === 0) return;

	formationPulse = new Set();
};

export const formationCandidatesOf = (root: object): ReadonlySet<object> =>
	formationCandidatesByRoot.get(rawTargetOf(root)) ?? emptyFormationCandidates;

export const takeFormationCandidates = (root: object): ReadonlySet<object> => {
	const key = rawTargetOf(root);
	const bucket = formationCandidatesByRoot.get(key);

	if (bucket === undefined) return emptyFormationCandidates;

	formationCandidatesByRoot.delete(key);

	return bucket;
};

export const clearFormationCandidates = (): void => {
	formationCandidatesByRoot = new WeakMap();
	formationPulse = new Set();
};

const segmentFor = (parent: object, key: string): string | number =>
	isPlainArray(parent) && isCanonicalArrayIndexString(key) ? Number(key) : key;

const segmentEquals = (left: string | number, right: string | number): boolean =>
	left === right || String(left) === String(right);

export const routeUnderPath = (route: OperationPath, formation: OperationPath): boolean => {
	if (route.length < formation.length) return false;

	for (let index = 0; index < formation.length; index++) {
		const routeSegment = route[index];
		const formationSegment = formation[index];

		if (routeSegment === undefined || formationSegment === undefined) return false;

		if (!segmentEquals(routeSegment, formationSegment)) return false;
	}

	return true;
};

export const externalRoutesOf = (
	routes: ReadonlyArray<OperationPath>,
	formation: OperationPath,
): ReadonlyArray<OperationPath> => routes.filter((route) => !routeUnderPath(route, formation));

export const canonicalRouteOf = (routes: ReadonlyArray<OperationPath>): OperationPath | undefined => routes[0];

export const resolveCandidates = (
	root: object,
	candidates: ReadonlySet<object>,
): ReadonlyMap<object, ReadonlyArray<OperationPath>> => {
	const wanted = new Set<object>();

	for (const candidate of candidates) wanted.add(rawTargetOf(candidate));

	if (wanted.size === 0) return new Map();

	const found = new Map<object, Array<OperationPath>>();
	const expanded = new Set<object>();

	const visit = (node: object, path: OperationPath): void => {
		const live = rawTargetOf(node);

		if (wanted.has(live)) {
			const routes = found.get(live);

			if (routes === undefined) found.set(live, [path]);
			else routes.push(path);
		}

		if (expanded.has(live)) return;

		expanded.add(live);

		for (const entry of walkDataEntries(node)) {
			const child: unknown = entry.value;

			if (typeof child !== "object" || child === null) continue;

			visit(child, createOperationPath([...path, segmentFor(node, entry.key)]));
		}
	};

	visit(root, createOperationPath([]));

	return found;
};
