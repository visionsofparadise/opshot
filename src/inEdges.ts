const parentMaps = new WeakMap<object, Map<WeakRef<object>, Set<string | number>>>();
const stateRoots = new WeakSet<object>();

const pruneAndFind = (
	parentMap: Map<WeakRef<object>, Set<string | number>>,
	parent: object,
): Set<string | number> | undefined => {
	let found: Set<string | number> | undefined;

	for (const [parentReference, keys] of parentMap) {
		const liveParent = parentReference.deref();

		if (liveParent === undefined) {
			parentMap.delete(parentReference);

			continue;
		}

		if (liveParent === parent) found = keys;
	}

	return found;
};

const materializeParents = (
	parentMap: Map<WeakRef<object>, Set<string | number>>,
): Map<object, Set<string | number>> => {
	const parents = new Map<object, Set<string | number>>();

	for (const [parentReference, keys] of parentMap) {
		const liveParent = parentReference.deref();

		if (liveParent === undefined) {
			parentMap.delete(parentReference);

			continue;
		}

		parents.set(liveParent, keys);
	}

	return parents;
};

export const registerInEdge = (child: object, parent: object, key: string | number): void => {
	let parentMap = parentMaps.get(child);

	if (parentMap === undefined) {
		parentMap = new Map();
		parentMaps.set(child, parentMap);
	}

	let keys = pruneAndFind(parentMap, parent);

	if (keys === undefined) {
		keys = new Set();
		parentMap.set(new WeakRef(parent), keys);
	}

	keys.add(key);
};

export const unregisterInEdge = (child: object, parent: object, key: string | number): void => {
	const parentMap = parentMaps.get(child);

	if (parentMap === undefined) return;

	const keys = pruneAndFind(parentMap, parent);

	if (keys === undefined) return;

	keys.delete(key);

	if (keys.size === 0) {
		for (const [parentReference, entry] of parentMap) {
			if (entry === keys) {
				parentMap.delete(parentReference);

				break;
			}
		}
	}

	if (parentMap.size === 0) parentMaps.delete(child);
};

export const parentsOf = (child: object): ReadonlyMap<object, ReadonlySet<string | number>> | undefined => {
	const parentMap = parentMaps.get(child);

	if (parentMap === undefined) return undefined;

	const parents = materializeParents(parentMap);

	if (parents.size === 0) {
		parentMaps.delete(child);

		return undefined;
	}

	return parents;
};

export const reachesNode = (start: object, goal: object, memo: Map<object, Map<object, boolean>>): boolean => {
	let goalMemo = memo.get(goal);

	if (goalMemo === undefined) {
		goalMemo = new Map();
		memo.set(goal, goalMemo);
	}

	const visiting = new Set<object>();
	const seen = new Set<object>();

	const visit = (node: object): boolean => {
		if (node === goal) return true;

		const cached = goalMemo.get(node);

		if (cached !== undefined) return cached;

		if (visiting.has(node)) return false;

		visiting.add(node);
		seen.add(node);

		const parents = parentsOf(node);
		let reaches = false;

		if (parents !== undefined) {
			for (const parent of parents.keys()) {
				if (visit(parent)) {
					reaches = true;

					break;
				}
			}
		}

		visiting.delete(node);

		if (reaches) goalMemo.set(node, true);

		return reaches;
	};

	const result = visit(start);

	if (!result) {
		for (const node of seen) {
			if (goalMemo.get(node) !== true) goalMemo.set(node, false);
		}
	}

	return result;
};

export const liveRootsOf = (node: object): ReadonlySet<object> => {
	const roots = new Set<object>();
	const visited = new Set<object>();

	const climb = (current: object): void => {
		if (visited.has(current)) return;

		visited.add(current);

		if (stateRoots.has(current)) roots.add(current);

		const parents = parentsOf(current);

		if (parents === undefined) return;

		for (const parent of parents.keys()) climb(parent);
	};

	climb(node);

	return roots;
};

export const markStateRoot = (target: object): void => {
	stateRoots.add(target);
};

export const isStateRoot = (target: object): boolean => stateRoots.has(target);
