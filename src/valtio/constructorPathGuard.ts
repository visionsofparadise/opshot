import { unstable_getInternalStates } from "valtio/vanilla";
import { resolveIdentity } from "../identity";
import { isTrackable } from "./classify";

const { refSet } = unstable_getInternalStates();

const constructorPathTargetCounts = new WeakMap<object, number>();

interface RootGraph {
	readonly root: WeakRef<object>;
	readonly finalizationState: RootFinalizationState;
	targets: Set<object>;
	constructorTargets: Map<object, number>;
}

interface RootFinalizationState {
	active: boolean;
	constructorTargets: Array<{ readonly target: WeakRef<object>; readonly count: number }>;
}

const rootGraphsByRoot = new WeakMap<object, RootGraph>();
const rootGraphReferences = new WeakMap<RootGraph, WeakRef<RootGraph>>();
const rootGraphsByTarget = new WeakMap<object, Set<WeakRef<RootGraph>>>();

const getRawObject = (value: unknown): object | undefined => {
	const resolved = resolveIdentity(value);

	return typeof resolved === "object" && resolved !== null ? resolved : undefined;
};

const getTrackedRawObject = (value: unknown): object | undefined => {
	const target = getRawObject(value);

	if (!target || refSet.has(target) || Object.isFrozen(target)) return undefined;

	return isTrackable(target) ? target : undefined;
};

export const getEnumerableDataChild = (target: object, key: PropertyKey): object | undefined => {
	if (typeof key !== "string") return undefined;

	const descriptor = Reflect.getOwnPropertyDescriptor(target, key);

	if (!descriptor?.enumerable || !("value" in descriptor)) return undefined;

	return getTrackedRawObject(descriptor.value);
};

const adjustConstructorPathTarget = (target: object, change: number): void => {
	const next = (constructorPathTargetCounts.get(target) ?? 0) + change;

	if (next > 0) constructorPathTargetCounts.set(target, next);
	else constructorPathTargetCounts.delete(target);
};

export const constructorPathTargetCount = (target: object): number => constructorPathTargetCounts.get(target) ?? 0;

const releaseFinalizationState = (state: RootFinalizationState): void => {
	if (!state.active) return;

	state.active = false;

	for (const { target, count } of state.constructorTargets) {
		const resolved = target.deref();

		if (resolved) adjustConstructorPathTarget(resolved, -count);
	}

	state.constructorTargets = [];
};

const rootGraphFinalizer = new FinalizationRegistry<RootFinalizationState>(releaseFinalizationState);

const getRootGraphReference = (graph: RootGraph): WeakRef<RootGraph> => {
	const existing = rootGraphReferences.get(graph);

	if (existing) return existing;

	const reference = new WeakRef(graph);

	rootGraphReferences.set(graph, reference);

	return reference;
};

const releaseRootGraph = (graph: RootGraph): void => {
	const reference = getRootGraphReference(graph);

	for (const target of graph.targets) {
		const references = rootGraphsByTarget.get(target);

		references?.delete(reference);

		if (references?.size === 0) rootGraphsByTarget.delete(target);
	}

	const root = graph.root.deref();

	if (root) rootGraphsByRoot.delete(root);

	releaseFinalizationState(graph.finalizationState);
	rootGraphFinalizer.unregister(graph.finalizationState);
	graph.targets.clear();
	graph.constructorTargets.clear();
};

// eslint-disable-next-line comment-rules/no-restricted-comments
/**
 * The sweep deletes from the reference set it iterates, safe only because each graph is represented by exactly one canonical WeakRef, so the only entry ever removed is the one already yielded.
 */
export const getRootGraphs = (target: object): Array<RootGraph> => {
	const references = rootGraphsByTarget.get(target);

	if (!references) return [];

	const graphs = new Array<RootGraph>();

	for (const reference of references) {
		const graph = reference.deref();

		if (!graph) {
			references.delete(reference);

			continue;
		}

		if (!graph.root.deref()) {
			releaseRootGraph(graph);

			continue;
		}

		graphs.push(graph);
	}

	if (references.size === 0) rootGraphsByTarget.delete(target);

	return graphs;
};

export const recomputeRootGraph = (graph: RootGraph): void => {
	const root = graph.root.deref();

	if (!root) {
		releaseRootGraph(graph);

		return;
	}

	const targets = new Set<object>();
	const constructorTargets = new Map<object, number>();

	const visit = (target: object): void => {
		if (targets.has(target)) return;

		targets.add(target);

		const constructorTarget = getEnumerableDataChild(target, "constructor");

		if (constructorTarget)
			constructorTargets.set(constructorTarget, (constructorTargets.get(constructorTarget) ?? 0) + 1);

		for (const key of Object.keys(target)) {
			const child = getEnumerableDataChild(target, key);

			if (child) visit(child);
		}
	};

	visit(root);

	for (const [target, count] of graph.constructorTargets) adjustConstructorPathTarget(target, -count);

	for (const [target, count] of constructorTargets) adjustConstructorPathTarget(target, count);

	for (const target of graph.targets) {
		if (targets.has(target)) continue;

		const references = rootGraphsByTarget.get(target);

		references?.delete(getRootGraphReference(graph));

		if (references?.size === 0) rootGraphsByTarget.delete(target);
	}

	for (const target of targets) {
		if (graph.targets.has(target)) continue;

		const references = rootGraphsByTarget.get(target) ?? new Set<WeakRef<RootGraph>>();

		references.add(getRootGraphReference(graph));
		rootGraphsByTarget.set(target, references);
	}

	graph.targets = targets;
	graph.constructorTargets = constructorTargets;
	graph.finalizationState.constructorTargets = [...constructorTargets].map(([target, count]) => ({
		target: new WeakRef(target),
		count,
	}));
};

export const registerTrackedRoot = (value: object): void => {
	const root = getTrackedRawObject(value);

	if (!root || rootGraphsByRoot.has(root)) return;

	const finalizationState: RootFinalizationState = { active: true, constructorTargets: [] };
	const graph: RootGraph = {
		root: new WeakRef(root),
		finalizationState,
		targets: new Set(),
		constructorTargets: new Map(),
	};

	rootGraphsByRoot.set(root, graph);
	rootGraphFinalizer.register(root, finalizationState, finalizationState);
	recomputeRootGraph(graph);
};

export const unregisterTrackedRoot = (value: object): void => {
	const root = getRawObject(value);
	const graph = root ? rootGraphsByRoot.get(root) : undefined;

	if (graph) releaseRootGraph(graph);
};
