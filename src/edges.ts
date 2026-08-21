import { unstable_getInternalStates } from "valtio/vanilla";
import { declarationChild, type DeclarationTrie } from "./declarations";
import { registerHandle, type Handle } from "./handle";
import { isPlainArray } from "./ops/cloneValue";
import { isCanonicalArrayIndexString } from "./ops/predicates";
import { peelReadProxy } from "./peelReadProxy";
import { walkDataEntries } from "./utils/dataEntries";
import { admissionLane } from "./valtio/classify";

const { proxyStateMap } = unstable_getInternalStates();

const rawTargetOf = (value: object): object => proxyStateMap.get(value)?.[0] ?? value;

const rawOf = (node: object): object => {
	const peeled = peelReadProxy(node);

	return rawTargetOf(typeof peeled === "object" && peeled !== null ? peeled : node);
};

const occupancyRootOf = (handle: Handle): object => rawTargetOf(handle.proxy.root);

const segmentFor = (parent: object, key: string): string | number =>
	isPlainArray(parent) && isCanonicalArrayIndexString(key) ? Number(key) : key;

export interface InEdge {
	readonly parent: object;
	readonly key: string | number;
}

const residualAlong = (
	trie: DeclarationTrie | undefined,
	path: ReadonlyArray<string | number>,
): DeclarationTrie | undefined => {
	let current = trie;

	for (const key of path) {
		current = declarationChild(current, key);

		if (current === undefined) return undefined;
	}

	return current;
};

const pathHasIgnored = (trie: DeclarationTrie, path: ReadonlyArray<string | number>): boolean => {
	if (trie.ignored) return true;

	let current: DeclarationTrie | undefined = trie;

	for (const key of path) {
		current = declarationChild(current, key);

		if (current === undefined) return false;

		if (current.ignored) return true;
	}

	return false;
};

const pathIsTainted = (trie: DeclarationTrie, path: ReadonlyArray<string | number>): boolean => {
	if (trie.unsafe) return true;

	let current: DeclarationTrie | undefined = trie;

	for (const key of path) {
		current = declarationChild(current, key);

		if (current === undefined) return false;

		if (current.unsafe) return true;
	}

	return false;
};

const walkGroundedChains = (
	handle: Handle,
	node: object,
	onGround: (pathFromRoot: ReadonlyArray<string | number>) => boolean,
): void => {
	const root = occupancyRootOf(handle);

	const walk = (current: object, reverseKeys: ReadonlyArray<string | number>, pathVisited: Set<object>): boolean => {
		if (current === root) return onGround([...reverseKeys].reverse());

		if (pathVisited.has(current)) return false;

		pathVisited.add(current);

		const edges = handle.inEdges.get(current);

		if (edges !== undefined) {
			for (const edge of edges) {
				if (walk(rawOf(edge.parent), [...reverseKeys, edge.key], pathVisited)) {
					pathVisited.delete(current);

					return true;
				}
			}
		}

		pathVisited.delete(current);

		return false;
	};

	walk(rawOf(node), [], new Set());
};

export function addInEdge(handle: Handle, node: object, parent: object, key: string | number): void {
	const rawNode = rawOf(node);
	const rawParent = rawOf(parent);
	let edges = handle.inEdges.get(rawNode);

	if (edges === undefined) {
		edges = [];
		handle.inEdges.set(rawNode, edges);
	}

	if (edges.some((edge) => rawOf(edge.parent) === rawParent && edge.key === key)) return;

	edges.push({ parent: rawParent, key });
	registerHandle(rawNode, handle);
}

export function removeInEdge(handle: Handle, node: object, parent: object, key: string | number): void {
	const rawNode = rawOf(node);
	const rawParent = rawOf(parent);
	const edges = handle.inEdges.get(rawNode);

	if (edges === undefined) return;

	const index = edges.findIndex((edge) => rawOf(edge.parent) === rawParent && edge.key === key);

	if (index === -1) return;

	edges.splice(index, 1);

	if (edges.length === 0) handle.inEdges.delete(rawNode);
}

export function edgeStatusOf(handle: Handle, node: object): { occupied: boolean; unsafe: boolean } {
	const rawNode = rawOf(node);
	const root = occupancyRootOf(handle);

	if (rawNode === root) {
		return { occupied: true, unsafe: handle.declarations?.unsafe === true };
	}

	if (handle.declarations === undefined) {
		let occupied = false;

		walkGroundedChains(handle, rawNode, () => {
			occupied = true;

			return true;
		});

		return { occupied, unsafe: false };
	}

	const declarations = handle.declarations;
	const status = { occupied: false, hasClean: false };

	walkGroundedChains(handle, rawNode, (pathFromRoot) => {
		status.occupied = true;

		if (!pathIsTainted(declarations, pathFromRoot)) {
			status.hasClean = true;

			return true;
		}

		return false;
	});

	return { occupied: status.occupied, unsafe: status.occupied && !status.hasClean };
}

/**
 * Whether `parent[key]` is an ignore frontier for this handle.
 *
 * If any grounded occupancy of `parent`, extended by `key`, is a declared
 * ignore terminal, the slot is not proxied (declared-wins).
 *
 * @param handle - State handle.
 * @param parent - Parent node of the slot.
 * @param key - Slot key.
 * @returns True when any grounded occupancy of `parent` extended by `key` is a declared ignore terminal.
 */
export function isIgnoredFrontier(handle: Handle, parent: object, key: string | number): boolean {
	const trie = handle.declarations;

	if (trie === undefined) return false;

	let hit = false;

	walkGroundedChains(handle, parent, (pathFromRoot) => {
		if (pathHasIgnored(trie, [...pathFromRoot, key])) {
			hit = true;

			return true;
		}

		return false;
	});

	return hit;
}

export function slotStatusOf(
	handle: Handle,
	parent: object,
	key: string | number,
): {
	readonly ignored: boolean;
	readonly occupied: boolean;
	readonly unsafe: boolean;
	readonly residual: DeclarationTrie | undefined;
} {
	const trie = handle.declarations;
	const status = {
		ignored: false,
		occupied: false,
		hasClean: false,
		cleanResidual: undefined as DeclarationTrie | undefined,
		firstResidual: undefined as DeclarationTrie | undefined,
	};

	walkGroundedChains(handle, parent, (pathFromRoot) => {
		status.occupied = true;

		const slotPath = [...pathFromRoot, key];
		const residual = residualAlong(trie, slotPath);

		status.firstResidual ??= residual;

		if (trie !== undefined && pathHasIgnored(trie, slotPath)) status.ignored = true;

		if (trie === undefined || !pathIsTainted(trie, slotPath)) {
			status.hasClean = true;
			status.cleanResidual = residual;
		}

		return status.ignored && status.hasClean;
	});

	return {
		ignored: status.ignored,
		occupied: status.occupied,
		unsafe: status.occupied && !status.hasClean,
		residual: status.cleanResidual ?? status.firstResidual,
	};
}

const seedFrom = (handle: Handle, node: object, residual: DeclarationTrie | undefined, visits: Set<object>): void => {
	if (residual?.ignored === true) return;

	const raw = rawOf(node);

	if (visits.has(raw)) return;

	visits.add(raw);

	for (const entry of walkDataEntries(raw)) {
		if (!entry.writable) continue;

		if (typeof entry.value !== "object" || entry.value === null) continue;

		if (admissionLane(entry.value) === "untracked") continue;

		const key = segmentFor(raw, entry.key);
		const childResidual = declarationChild(residual, key);

		if (childResidual?.ignored === true) continue;

		addInEdge(handle, entry.value, raw, key);
		seedFrom(handle, entry.value, childResidual, visits);
	}
};

export function seedInEdges(handle: Handle): void {
	seedFrom(handle, handle.proxy.root, handle.declarations, new Set());
}

export function seedInEdgesUnder(handle: Handle, node: object, residual: DeclarationTrie | undefined): void {
	seedFrom(handle, node, residual, new Set());
}
