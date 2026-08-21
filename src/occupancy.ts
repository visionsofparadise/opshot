import { unstable_getInternalStates } from "valtio/vanilla";
import { descendChains, isIgnoredFrontier, slotStatusOf } from "./edges";
import { getRegisteredTarget } from "./identity";
import { commitVends, stageVend } from "./intern";
import { isPlainArray } from "./ops/cloneValue";
import { appendOperationPath, createOperationPath, formatOperationPath, type OperationPath } from "./ops/path";
import { isCanonicalArrayIndexString, isObjectLike } from "./ops/predicates";
import { walkDataEntries } from "./utils/dataEntries";
import { nonWritablePropertyError, rejectionError } from "./valtio/boundaryErrors";
import { admissionDecision, classifyValue } from "./valtio/classify";
import type { DeclarationTrie } from "./declarations";
import type { DirtyIndex, Handle } from "./handle";

const { proxyStateMap } = unstable_getInternalStates();

const rawTargetOf = (value: object): object => proxyStateMap.get(value)?.[0] ?? value;

const liveOf = (value: object): object => getRegisteredTarget(value) ?? rawTargetOf(value);

export type OccupancyVisit = "omit" | "skip" | "continue";

export interface CaptureTables {
	refusals: Array<Error>;
	omissions: Set<string>;
	mints: Array<{ readonly node: object; readonly id: number }>;
}

export const createCaptureTables = (): CaptureTables => ({
	refusals: [],
	omissions: new Set(),
	mints: [],
});

export class OccupancyRefusalError extends Error {
	constructor(refusal: Error) {
		super(refusal.message, refusal instanceof AggregateError ? { cause: refusal } : undefined);
		this.name = "OccupancyRefusalError";
	}
}

const occupancyKeyOf = (key: string | number | symbol): string | symbol =>
	typeof key === "number" ? String(key) : key;

const segmentFor = (parent: object, key: string): string | number =>
	isPlainArray(parent) && isCanonicalArrayIndexString(key) ? Number(key) : key;

const pathKeyOf = (path: OperationPath): string => formatOperationPath(path);

const pathAsStrings = (path: OperationPath): Array<string> => path.map((segment) => String(segment));

const collectRefusal = (capture: CaptureTables, error: Error, pathKey: string): void => {
	capture.refusals.push(error);
	capture.omissions.add(pathKey);
};

export function bindVisitedOccupancy(
	handle: Handle,
	path: OperationPath,
	parent: object,
	key: string | number,
	child: unknown,
	capture: CaptureTables,
	sameOccupant = false,
	unsafe = false,
): OccupancyVisit {
	if (path.length === 0) return "continue";

	if (isIgnoredFrontier(handle, parent, key)) return "skip";

	const pathKey = pathKeyOf(path);

	if (capture.omissions.has(pathKey)) return "omit";

	const parentRaw = liveOf(parent);
	const occupancyKey = occupancyKeyOf(key);
	const admitted = unsafe || !handle.strict;

	if (typeof child === "function") {
		const parentKind = classifyValue(parentRaw);

		if (parentKind === "plain" || parentKind === "plainArray") return "continue";

		if (admitted || sameOccupant) return "continue";

		collectRefusal(capture, rejectionError(parentRaw, parentKind, pathAsStrings(path)), pathKey);

		return "omit";
	}

	const stored: unknown = Reflect.get(parentRaw, occupancyKey);
	const occupantSource = isObjectLike(stored) ? stored : child;

	if (typeof occupantSource !== "object" || occupantSource === null) return "continue";

	const childLive = liveOf(occupantSource);
	const descriptor = Reflect.getOwnPropertyDescriptor(parentRaw, occupancyKey);

	if (descriptor !== undefined && descriptor.writable !== true && admissionDecision(childLive).lane !== "untracked") {
		if (admitted) return "skip";

		if (sameOccupant) return "skip";

		collectRefusal(capture, nonWritablePropertyError(childLive, pathAsStrings(path)), pathKey);

		return "omit";
	}

	const decision = admissionDecision(childLive);

	if (decision.lane === "untracked") return "skip";

	if (decision.lane === "dangerous") {
		if (admitted) return "continue";

		if (sameOccupant) return "skip";

		collectRefusal(capture, rejectionError(childLive, decision.kind, pathAsStrings(path)), pathKey);

		return "omit";
	}

	if (!admitted && classifyValue(childLive) === "cleanClass") {
		for (const entry of walkDataEntries(childLive)) {
			if (typeof entry.value !== "function") continue;

			if (sameOccupant) break;

			collectRefusal(
				capture,
				rejectionError(childLive, "cleanClass", pathAsStrings(appendOperationPath(path, entry.key))),
				pathKey,
			);

			return "omit";
		}
	}

	return "continue";
}

export function markDirtyPath(
	dirty: DirtyIndex,
	handle: Handle,
	path: OperationPath,
	parentLive: object | undefined,
): void {
	let current: unknown = handle.proxy.root;

	if (isObjectLike(current)) dirty.nodes.add(rawTargetOf(current));

	for (const segment of path) {
		if (!isObjectLike(current)) break;

		current = Reflect.get(current, segment);

		if (isObjectLike(current)) dirty.nodes.add(rawTargetOf(current));
	}

	if (parentLive === undefined || path.length === 0) return;

	const lastSegment = path[path.length - 1];

	if (lastSegment === undefined) return;

	const edge = typeof lastSegment === "number" ? String(lastSegment) : lastSegment;
	const parentRaw = rawTargetOf(parentLive);
	let edges = dirty.edges.get(parentRaw);

	if (edges === undefined) {
		edges = new Set();
		dirty.edges.set(parentRaw, edges);
	}

	edges.add(edge);
}

const walkLiveOccupancies = (handle: Handle, sameOccupant: boolean, capture: CaptureTables): void => {
	const root = handle.proxy.root;
	const visits = new Set<object>();
	const rootChains: ReadonlyArray<DeclarationTrie | undefined> =
		handle.declarations?.unsafe === true ? [] : [handle.declarations];

	const walk = (node: object, path: OperationPath, chains: ReadonlyArray<DeclarationTrie | undefined>): void => {
		if (chains.some((residual) => residual?.ignored === true)) return;

		stageVend(handle, capture, node);

		const nodeRaw = rawTargetOf(node);

		if (visits.has(nodeRaw)) return;

		visits.add(nodeRaw);

		for (const entry of walkDataEntries(node)) {
			const key = segmentFor(node, entry.key);
			const childPath = appendOperationPath(path, key);
			const slot = slotStatusOf(handle, node, key);
			const descended = descendChains(chains, key);
			const ignored = slot.ignored || descended.ignored;
			const unsafe = slot.occupied ? slot.unsafe : descended.unsafe;
			const childChains = slot.occupied ? slot.chains : descended.chains;

			if (ignored) continue;

			const visit = bindVisitedOccupancy(
				handle,
				childPath,
				node,
				entry.key,
				entry.value,
				capture,
				sameOccupant,
				unsafe,
			);

			if (visit !== "continue") continue;

			if (typeof entry.value === "object" && entry.value !== null) walk(entry.value, childPath, childChains);
		}
	};

	walk(root, createOperationPath([]), rootChains);
};

export function seedOccupancies(handle: Handle): void {
	const capture = createCaptureTables();

	walkLiveOccupancies(handle, false, capture);
	commitVends(handle, capture);
}

export function syncHandleTables(handle: Handle, capture: CaptureTables): void {
	walkLiveOccupancies(handle, true, capture);
}
