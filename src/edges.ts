import { unstable_getInternalStates } from "valtio/vanilla";
import { declarationChild, type DeclarationTrie } from "./declarations";
import { registerHandle, type Handle } from "./handle";
import { queueDeparture } from "./intern";
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

	if (edges.length === 0) {
		handle.inEdges.delete(rawNode);
		queueDeparture(handle, rawNode);
	}
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

export interface ChainStatus {
	readonly occupied: boolean;
	readonly unsafe: boolean;
	readonly ignored: boolean;
	readonly chains: ReadonlyArray<DeclarationTrie | undefined>;
}

interface NodeChain {
	readonly residual: DeclarationTrie | undefined;
	readonly tainted: boolean;
	readonly ignored: boolean;
}

interface NodeChainSet {
	readonly occupied: boolean;
	readonly entries: ReadonlyArray<NodeChain>;
}

const uniqueNodeChains = (entries: ReadonlyArray<NodeChain>): Array<NodeChain> => {
	const unique = new Array<NodeChain>();
	const undefinedFlags = new Set<string>();
	const definedFlags = new WeakMap<object, Set<string>>();

	for (const entry of entries) {
		const flags = `${entry.tainted ? "1" : "0"}${entry.ignored ? "1" : "0"}`;

		if (entry.residual === undefined) {
			if (undefinedFlags.has(flags)) continue;

			undefinedFlags.add(flags);
			unique.push(entry);

			continue;
		}

		let seen = definedFlags.get(entry.residual);

		if (seen === undefined) {
			seen = new Set();
			definedFlags.set(entry.residual, seen);
		}

		if (seen.has(flags)) continue;

		seen.add(flags);
		unique.push(entry);
	}

	return unique;
};

const uniqueResiduals = (residuals: ReadonlyArray<DeclarationTrie | undefined>): Array<DeclarationTrie | undefined> => {
	const unique = new Array<DeclarationTrie | undefined>();
	let sawUndefined = false;
	const seen = new Set<DeclarationTrie>();

	for (const residual of residuals) {
		if (residual === undefined) {
			if (sawUndefined) continue;

			sawUndefined = true;
			unique.push(undefined);

			continue;
		}

		if (seen.has(residual)) continue;

		seen.add(residual);
		unique.push(residual);
	}

	return unique;
};

const chainsAtNode = (
	handle: Handle,
	node: object,
	memo: Map<object, NodeChainSet>,
	computing: Set<object>,
): NodeChainSet => {
	const raw = rawOf(node);
	const cached = memo.get(raw);

	if (cached !== undefined) return cached;

	if (computing.has(raw)) return { occupied: false, entries: [] };

	if (raw === occupancyRootOf(handle)) {
		const trie = handle.declarations;
		const result: NodeChainSet = {
			occupied: true,
			entries: [
				{
					residual: trie,
					tainted: trie?.unsafe === true,
					ignored: trie?.ignored === true,
				},
			],
		};

		memo.set(raw, result);

		return result;
	}

	computing.add(raw);

	const aggregated = new Array<NodeChain>();
	let occupied = false;
	const edges = handle.inEdges.get(raw);

	if (edges !== undefined) {
		for (const edge of edges) {
			const parent = chainsAtNode(handle, edge.parent, memo, computing);

			if (!parent.occupied) continue;

			occupied = true;

			for (const entry of parent.entries) {
				const child = entry.residual === undefined ? undefined : declarationChild(entry.residual, edge.key);

				aggregated.push({
					residual: child,
					tainted: entry.tainted || child?.unsafe === true,
					ignored: entry.ignored || child?.ignored === true,
				});
			}
		}
	}

	computing.delete(raw);

	const result: NodeChainSet = { occupied, entries: uniqueNodeChains(aggregated) };

	memo.set(raw, result);

	return result;
};

export function descendChains(
	chains: ReadonlyArray<DeclarationTrie | undefined>,
	key: string | number,
): {
	readonly ignored: boolean;
	readonly unsafe: boolean;
	readonly chains: ReadonlyArray<DeclarationTrie | undefined>;
} {
	const next = new Array<DeclarationTrie | undefined>();
	let ignored = false;

	for (const residual of chains) {
		if (residual === undefined) {
			next.push(undefined);

			continue;
		}

		const child = declarationChild(residual, key);

		if (child?.ignored === true) ignored = true;

		if (child?.unsafe === true) continue;

		next.push(child);
	}

	return {
		ignored,
		unsafe: chains.length > 0 && next.length === 0,
		chains: uniqueResiduals(next),
	};
}

export function slotStatusOf(handle: Handle, parent: object, key: string | number): ChainStatus {
	const parentChains = chainsAtNode(handle, parent, new Map(), new Set());

	if (!parentChains.occupied) {
		return { occupied: false, unsafe: false, ignored: false, chains: [] };
	}

	const chains = new Array<DeclarationTrie | undefined>();
	let ignored = false;

	for (const entry of parentChains.entries) {
		const child = entry.residual === undefined ? undefined : declarationChild(entry.residual, key);
		const slotIgnored = entry.ignored || child?.ignored === true;
		const tainted = entry.tainted || child?.unsafe === true;

		if (slotIgnored) ignored = true;

		if (!tainted) chains.push(child);
	}

	return {
		ignored,
		occupied: true,
		unsafe: chains.length === 0,
		chains: uniqueResiduals(chains),
	};
}

const seedFrom = (
	handle: Handle,
	node: object,
	chains: ReadonlyArray<DeclarationTrie | undefined>,
	visits: Set<object>,
): void => {
	if (chains.some((residual) => residual?.ignored === true)) return;

	const raw = rawOf(node);

	if (visits.has(raw)) return;

	visits.add(raw);

	for (const entry of walkDataEntries(raw)) {
		if (!entry.writable) continue;

		if (typeof entry.value !== "object" || entry.value === null) continue;

		if (admissionLane(entry.value) === "untracked") continue;

		const key = segmentFor(raw, entry.key);
		const slot = slotStatusOf(handle, raw, key);
		const descended = descendChains(chains, key);

		if (slot.ignored || descended.ignored) continue;

		addInEdge(handle, entry.value, raw, key);
		seedFrom(handle, entry.value, slot.occupied ? slot.chains : descended.chains, visits);
	}
};

export function seedInEdges(handle: Handle): void {
	seedFrom(handle, handle.proxy.root, handle.declarations?.unsafe === true ? [] : [handle.declarations], new Set());
}

export function seedInEdgesUnder(
	handle: Handle,
	node: object,
	chains: ReadonlyArray<DeclarationTrie | undefined>,
): void {
	seedFrom(handle, node, chains, new Set());
}
