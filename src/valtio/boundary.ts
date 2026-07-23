import { getUntracked, markToTrack } from "proxy-compare";
import { unstable_getInternalStates, unstable_replaceInternalFunction } from "valtio/vanilla";

import { getRegisteredTarget, registerSnapshotCopy, resolveIdentity } from "../identity";
import { isUnsafeTracked, unsafeTrack } from "../unsafeTrack";
import { classifyValue, hasOwnEnumerableFunction, isTrackable } from "./classify";

export { classifyValue, type ValueKind } from "./classify";

// refSet is the only runtime marker ref() leaves on a value; valtio exposes it nowhere else.
const { refSet, proxyStateMap, snapCache } = unstable_getInternalStates();

export interface DirectWriteGeneration {
	readonly version: number;
}

const directWriteGenerationRegistryKey = Symbol.for("opshot.directWriteGenerations");
const snapshotDirectWriteGenerationRegistryKey = Symbol.for("opshot.snapshotDirectWriteGenerations");
const fallbackDirectWriteGenerations = new WeakMap<object, DirectWriteGeneration>();
const fallbackSnapshotDirectWriteGenerations = new WeakMap<object, DirectWriteGeneration>();
const isGenerationRegistry = (value: unknown): value is WeakMap<object, DirectWriteGeneration> => value instanceof WeakMap && Object.getPrototypeOf(value) === WeakMap.prototype;

const getGenerationRegistry = (key: symbol, fallback: WeakMap<object, DirectWriteGeneration>): WeakMap<object, DirectWriteGeneration> => {
	try {
		const existing: unknown = Reflect.get(globalThis, key);

		if (isGenerationRegistry(existing)) return existing;

		const registry = new WeakMap<object, DirectWriteGeneration>();

		if (!Reflect.defineProperty(globalThis, key, { value: registry })) return fallback;

		return registry;
	} catch {
		return fallback;
	}
};

const directWriteGenerations = getGenerationRegistry(directWriteGenerationRegistryKey, fallbackDirectWriteGenerations);
const snapshotDirectWriteGenerations = getGenerationRegistry(snapshotDirectWriteGenerationRegistryKey, fallbackSnapshotDirectWriteGenerations);

const advanceDirectWriteGeneration = (target: object): void => {
	const current = directWriteGenerations.get(target);

	if (current !== undefined) directWriteGenerations.set(target, { version: current.version + 1 });
};

const registerDirectWriteSnapshot = (copy: object, target: object): void => {
	const generation = directWriteGenerations.get(target);

	if (generation === undefined) return;

	snapshotDirectWriteGenerations.set(copy, generation);
};

export const getDirectWriteGeneration = (value: object): DirectWriteGeneration | undefined => {
	const source = getUntracked(value) ?? value;
	const proxyState = proxyStateMap.get(source);

	if (proxyState === undefined) return snapshotDirectWriteGenerations.get(source);

	const target = proxyState[0];
	const generation = directWriteGenerations.get(target) ?? { version: 0 };

	directWriteGenerations.set(target, generation);

	return generation;
};

export const getDirectWriteVersion = (value: object): number | undefined => getDirectWriteGeneration(value)?.version;

const ignoreOption = "ignore(value) to store it by reference, untracked";
const unsafeTrackDataOption = "unsafeTrack(value) to track its data anyway";
const unsafeTrackPrivateOption = "unsafeTrack(value) tracks public fields while private methods throw on snapshots and undo drops that state";
const unsafeTrackSlotOption = "unsafeTrack(value) tracks public fields while slot methods throw on snapshots and undo drops that state";
const unsafeTrackLossyOption = "unsafeTrack(value) to track it lossily";

export const constructorName = (candidate: unknown): string => (typeof candidate === "function" && candidate.name !== "" ? candidate.name : "Object");

const boundaryError = (className: string, reason: string, options: Array<string>): Error =>
	new Error(`opshot: ${className} cannot be tracked (${reason}). Options: ${options.join("; ")}.`);

const slotContainerError = (className: string, trackedName: string): Error =>
	boundaryError(className, "its state lives in internal slots", [`use ${trackedName} for a tracked equivalent`, unsafeTrackLossyOption, ignoreOption]);

const arraySubclassError = (className: string): Error =>
	boundaryError(className, "array subclasses lose their prototype in snapshots", [unsafeTrackDataOption, ignoreOption]);

const cleanClassError = (className: string): Error =>
	boundaryError(className, "arrow-method writes won't be tracked", [unsafeTrackDataOption, ignoreOption]);

const privateClassError = (className: string): Error =>
	boundaryError(className, "its state is hidden in private fields", [unsafeTrackPrivateOption, ignoreOption]);

const nativeClassError = (className: string): Error =>
	boundaryError(className, "its state is hidden in internal slots", [unsafeTrackSlotOption, ignoreOption]);

const snapshotDonationError = (key: string | symbol): Error =>
	new Error(
		`opshot: cannot assign a snapshot generation at "${String(key)}": a snapshot generation is a read-view, and assigning it creates a dead region. Clone the value, or replay through applyOps.`,
	);

const reservedDataPathError = (path: ReadonlyArray<string>): Error => new Error(`opshot: reserved data path /${path.join("/")}`);
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

const getEnumerableDataChild = (target: object, key: PropertyKey): object | undefined => {
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

const getRootGraphs = (target: object): Array<RootGraph> => {
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

const recomputeRootGraph = (graph: RootGraph): void => {
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

		if (constructorTarget) constructorTargets.set(constructorTarget, (constructorTargets.get(constructorTarget) ?? 0) + 1);

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
	graph.finalizationState.constructorTargets = [...constructorTargets].map(([target, count]) => ({ target: new WeakRef(target), count }));
};

export const registerTrackedRoot = (value: object): void => {
	const root = getTrackedRawObject(value);

	if (!root || rootGraphsByRoot.has(root)) return;

	const finalizationState: RootFinalizationState = { active: true, constructorTargets: [] };
	const graph: RootGraph = { root: new WeakRef(root), finalizationState, targets: new Set(), constructorTargets: new Map() };

	rootGraphsByRoot.set(root, graph);
	rootGraphFinalizer.register(root, finalizationState, finalizationState);
	recomputeRootGraph(graph);
};

export const unregisterTrackedRoot = (value: object): void => {
	const root = getRawObject(value);
	const graph = root ? rootGraphsByRoot.get(root) : undefined;

	if (graph) releaseRootGraph(graph);
};

export const assertSafeDataPaths = (value: unknown, path = new Array<string>(), activeAncestors = new WeakSet()): void => {
	if (typeof value !== "object" || value === null || activeAncestors.has(value)) return;

	activeAncestors.add(value);

	try {
		for (const key of Object.keys(value)) {
			const nextPath = [...path, key];

			if (key === "__proto__" || (key === "prototype" && path[path.length - 1] === "constructor")) throw reservedDataPathError(nextPath);

			const descriptor = Reflect.getOwnPropertyDescriptor(value, key);

			if (descriptor && "value" in descriptor) assertSafeDataPaths(descriptor.value, nextPath, activeAncestors);
		}
	} finally {
		activeAncestors.delete(value);
	}
};

const rejectionError = (value: object, kind: "arraySubclass" | "cleanClass" | "privateClass" | "nativeClass"): Error => {
	const className = constructorName(value.constructor);
	const prototype: unknown = Object.getPrototypeOf(value);

	if (prototype === Map.prototype) return slotContainerError(className, "TrackedMap");
	if (prototype === Set.prototype) return slotContainerError(className, "TrackedSet");
	if (prototype === Date.prototype) return slotContainerError(className, "TrackedDate");

	switch (kind) {
		case "arraySubclass":
			return arraySubclassError(className);
		case "cleanClass":
			return cleanClassError(className);
		case "privateClass":
			return privateClassError(className);
		case "nativeClass":
			return nativeClassError(className);
	}
};

// snapCache must seed BEFORE the property walk (snapshot identity depends on it), and child recursion must call THIS function by name -- the default recurses by its own name and would rebuild children without the added accessor branch.
const createSnapshotPreservingAccessors = <T extends object>(target: T, version: number): T => {
	const cached = snapCache.get(target);

	if (cached?.[0] === version) {
		const cachedSnapshot = cached[1] as T;

		registerSnapshotCopy(cachedSnapshot, target);
		registerDirectWriteSnapshot(cachedSnapshot, target);

		return cachedSnapshot;
	}

	const snap: object = Array.isArray(target) ? [] : (Object.create(Reflect.getPrototypeOf(target)) as object);

	registerSnapshotCopy(snap, target);
	registerDirectWriteSnapshot(snap, target);
	markToTrack(snap, true);
	snapCache.set(target, [version, snap]);

	for (const key of Reflect.ownKeys(target)) {
		if (Object.getOwnPropertyDescriptor(snap, key)) continue;

		const descriptor = Reflect.getOwnPropertyDescriptor(target, key);

		if (!descriptor) continue;

		if (descriptor.get || descriptor.set) {
			Object.defineProperty(snap, key, {
				get: descriptor.get,
				set: descriptor.set,
				enumerable: descriptor.enumerable,
				configurable: true,
			});

			continue;
		}

		const value: unknown = Reflect.get(target, key);
		const snapshotDescriptor: PropertyDescriptor = { value, enumerable: descriptor.enumerable, configurable: true };

		if (typeof value === "object" && value !== null) {
			if (refSet.has(value)) {
				markToTrack(value, false);
			} else {
				const childState = proxyStateMap.get(value);

				if (childState) snapshotDescriptor.value = createSnapshotPreservingAccessors(childState[0], childState[1]());
			}
		}

		Object.defineProperty(snap, key, snapshotDescriptor);
	}

	if (Array.isArray(target) && (snap as Array<unknown>).length !== (target as Array<unknown>).length) {
		(snap as Array<unknown>).length = (target as Array<unknown>).length;
	}

	if (isUnsafeTracked(target)) unsafeTrack(snap);

	return snap as T;
};

let installed = false;

export function installBoundary(): void {
	if (installed) return;

	installed = true;

	unstable_replaceInternalFunction("canProxy", () => (value) => {
		if (typeof value !== "object" || value === null) return false;
		if (refSet.has(value)) return false;
		if (isUnsafeTracked(value)) return true;

		const kind = classifyValue(value);

		if (kind === "plain" || kind === "plainArray") return !Object.isFrozen(value);
		if (kind === "cleanClass" && !hasOwnEnumerableFunction(value)) return true;

		throw rejectionError(value, kind);
	});

	unstable_replaceInternalFunction("createSnapshot", () => createSnapshotPreservingAccessors);

	unstable_replaceInternalFunction(
		"createHandler",
		(createHandler) => (isInitializing, addPropListener, removePropListener, notifyUpdate) => {
			let setDepth = 0;

			const handler = createHandler(isInitializing, addPropListener, removePropListener, notifyUpdate);
			const defaultDelete = handler.deleteProperty;
			const defaultSet = handler.set;

			if (!defaultDelete || !defaultSet) throw new Error("opshot: valtio default handler is missing a mutation trap");

			return {
				...handler,
				deleteProperty(target, prop) {
					const rootGraphs = getRootGraphs(target);
					const previousChild = rootGraphs.length > 0 ? getEnumerableDataChild(target, prop) : undefined;
					const tracksDirectWrites = directWriteGenerations.has(target);
					const hadOwn = Object.hasOwn(target, prop);
					const deleted = defaultDelete(target, prop);

					if (deleted && hadOwn && previousChild && !Object.hasOwn(target, prop)) for (const graph of rootGraphs) recomputeRootGraph(graph);

					if (tracksDirectWrites && deleted && hadOwn && !Object.hasOwn(target, prop)) advanceDirectWriteGeneration(target);

					return deleted;
				},
				set(target, prop, value, receiver) {
					// ProxyHandler types value as any; the unknown local restores narrowing.
					const assigned: unknown = value;

					if (prop === "__proto__") throw reservedDataPathError(["__proto__"]);
					if (prop === "prototype" && (constructorPathTargetCounts.get(target) ?? 0) > 0) throw reservedDataPathError(["constructor", "prototype"]);
					if (prop === "constructor" && typeof assigned === "object" && assigned !== null) {
						const prototypeDescriptor = Reflect.getOwnPropertyDescriptor(assigned, "prototype");

						if (prototypeDescriptor?.enumerable) throw reservedDataPathError(["constructor", "prototype"]);
					}

					assertSafeDataPaths(assigned, typeof prop === "string" ? [prop] : []);

					if (typeof assigned === "object" && assigned !== null) {
						const untracked = getUntracked(assigned) ?? assigned;

						if (getRegisteredTarget(untracked) !== undefined) throw snapshotDonationError(prop);
					}

					const tracksDirectWrites = directWriteGenerations.has(target);
					const rootGraphs = getRootGraphs(target);
					const previousChild = rootGraphs.length > 0 ? getEnumerableDataChild(target, prop) : undefined;
					const previousLength: unknown = rootGraphs.length > 0 && Array.isArray(target) && prop === "length" ? Reflect.get(target, "length") : undefined;
					const hadOwn = tracksDirectWrites && Object.hasOwn(target, prop);
					const previous: unknown = tracksDirectWrites ? Reflect.get(target, prop, receiver) : undefined;

					setDepth += 1;

					try {
						const written = defaultSet(target, prop, value, receiver);
						const currentChild = rootGraphs.length > 0 ? getEnumerableDataChild(target, prop) : undefined;
						const currentLength: unknown = previousLength === undefined ? undefined : Reflect.get(target, "length");

						if (previousChild !== currentChild || previousLength !== currentLength) for (const graph of rootGraphs) recomputeRootGraph(graph);

						if (tracksDirectWrites) {
							const hasOwn = Object.hasOwn(target, prop);
							const current: unknown = Reflect.get(target, prop, receiver);

							if (written && (hadOwn !== hasOwn || !Object.is(previous, current))) advanceDirectWriteGeneration(target);
						}

						return written;
					} finally {
						setDepth -= 1;
					}
				},
				defineProperty(target, prop, descriptor) {
					if (setDepth > 0 || isInitializing()) return Reflect.defineProperty(target, prop, descriptor);

					throw new Error("opshot: defineProperty is not supported on tracked state; define properties in the createState literal");
				},
				setPrototypeOf() {
					throw new Error("opshot: setPrototypeOf is not supported on tracked state");
				},
			};
		},
	);
}
