import { getVersion, unstable_getInternalStates } from "valtio/vanilla";
import { isRendering, learnNonRenderDispatcher } from "./renderPhase";
import { getRegisteredWrapperTarget, registerWrapperTarget } from "./wrapperRegistry";

const { refSet, proxyStateMap } = unstable_getInternalStates();

const KEYS_PROPERTY = "k";
const HAS_KEY_PROPERTY = "h";
const HAS_OWN_KEY_PROPERTY = "o";
const ALL_OWN_KEYS_PROPERTY = "w";

const isObjectLike = (value: unknown): value is object =>
	value !== null && (typeof value === "object" || typeof value === "function");
const isLiveProxy = (value: object): boolean => proxyStateMap.has(value);
const getProxyTarget = (liveProxy: object): object => proxyStateMap.get(liveProxy)?.[0] ?? liveProxy;
const getProxyVersion = (liveProxy: object): number => getVersion(liveProxy) ?? 0;

interface UsageRecord {
	[KEYS_PROPERTY]?: Set<string | symbol>;
	[HAS_KEY_PROPERTY]?: Set<string | symbol>;
	[HAS_OWN_KEY_PROPERTY]?: Set<string | symbol>;
	[ALL_OWN_KEYS_PROPERTY]?: true;
}

interface SourcePartition {
	readonly sourceProxy: object;
	readonly affected: Map<object, UsageRecord>;
	readonly prevValues: Map<object, Map<string | symbol, unknown>>;
	readonly prevHas: Map<object, Map<string | symbol, boolean>>;
	readonly prevHasOwn: Map<object, Map<string | symbol, boolean>>;
	readonly prevOwnKeys: Map<object, ReadonlyArray<string | symbol>>;
	readonly versionAtRecord: Map<object, number>;
	readonly proxyCache: WeakMap<object, { wrapper: object; version: number }>;
}

export interface Boundary {
	wrap<T extends object>(sourceProxy: T): T;

	readsChanged(sourceProxy: object): boolean;

	resetReads(): void;

	captureReads(): void;

	retain(): void;

	dispose(): void;
}

const getUsage = (affected: Map<object, UsageRecord>, target: object): UsageRecord => {
	let used = affected.get(target);

	if (used === undefined) {
		used = {};
		affected.set(target, used);
	}

	return used;
};

const recordKey = (
	used: UsageRecord,
	type: typeof KEYS_PROPERTY | typeof HAS_KEY_PROPERTY | typeof HAS_OWN_KEY_PROPERTY,
	key: string | symbol,
): void => {
	let set = used[type];

	if (set === undefined) {
		set = new Set();
		used[type] = set;
	}

	set.add(key);
};

const storeFirst = <T>(
	store: Map<object, Map<string | symbol, T>>,
	node: object,
	key: string | symbol,
	value: T,
): void => {
	let entries = store.get(node);

	if (entries === undefined) {
		entries = new Map();
		store.set(node, entries);
	}

	if (!entries.has(key)) entries.set(key, value);
};

const getPrototypeMethod = (target: object, prop: string | symbol): Function | undefined => {
	let prototype = Reflect.getPrototypeOf(target);

	while (prototype !== null) {
		const descriptor = Reflect.getOwnPropertyDescriptor(prototype, prop);

		if (descriptor !== undefined) {
			const descriptorValue: unknown = "value" in descriptor ? descriptor.value : undefined;

			return typeof descriptorValue === "function" ? descriptorValue : undefined;
		}

		prototype = Reflect.getPrototypeOf(prototype);
	}

	return undefined;
};

const wrapperBoundMethods = new WeakMap<object, WeakMap<Function, Function>>();

const bindMethodToWrapper = (wrapper: object, method: Function): Function => {
	let methods = wrapperBoundMethods.get(wrapper);

	if (methods === undefined) {
		methods = new WeakMap();
		wrapperBoundMethods.set(wrapper, methods);
	}

	const existing = methods.get(method);

	if (existing !== undefined) return existing;

	const bound = Function.prototype.bind.call(method, wrapper) as Function;

	methods.set(method, bound);

	return bound;
};

export const isWrapper = (value: unknown): boolean =>
	isObjectLike(value) && getRegisteredWrapperTarget(value) !== undefined;

export function createBoundary(): Boundary {
	const partitions = new Map<object, SourcePartition>();
	let afterRender = false;
	let releasing = false;

	const getPartition = (sourceProxy: object): SourcePartition => {
		let partition = partitions.get(sourceProxy);

		if (partition === undefined) {
			partition = {
				sourceProxy,
				affected: new Map(),
				prevValues: new Map(),
				prevHas: new Map(),
				prevHasOwn: new Map(),
				prevOwnKeys: new Map(),
				versionAtRecord: new Map(),
				proxyCache: new WeakMap(),
			};
			partitions.set(sourceProxy, partition);
		}

		return partition;
	};

	const shouldRecord = (): boolean => !afterRender || isRendering();

	const trackUsage = (partition: SourcePartition, liveProxy: object): UsageRecord =>
		shouldRecord() ? getUsage(partition.affected, liveProxy) : {};

	const storeValue = (partition: SourcePartition, liveProxy: object, key: string | symbol, value: unknown): void => {
		if (!shouldRecord()) return;

		storeFirst(partition.prevValues, liveProxy, key, value);

		if (isObjectLike(value) && isLiveProxy(value) && !partition.versionAtRecord.has(value)) {
			partition.versionAtRecord.set(value, getProxyVersion(value));
		}
	};

	const storeHas = (partition: SourcePartition, liveProxy: object, key: string | symbol): void => {
		if (!shouldRecord()) return;

		storeFirst(partition.prevHas, liveProxy, key, Reflect.has(liveProxy, key));
	};

	const storeHasOwn = (partition: SourcePartition, liveProxy: object, key: string | symbol): void => {
		if (!shouldRecord()) return;

		storeFirst(partition.prevHasOwn, liveProxy, key, Reflect.getOwnPropertyDescriptor(liveProxy, key) !== undefined);
	};

	const storeOwnKeys = (partition: SourcePartition, liveProxy: object): void => {
		if (!shouldRecord()) return;

		if (partition.prevOwnKeys.has(liveProxy)) return;

		partition.prevOwnKeys.set(liveProxy, Reflect.ownKeys(liveProxy));
	};

	const isComparableProxy = (value: unknown): value is object => isObjectLike(value) && isLiveProxy(value);

	const nodeChanged = (
		partition: SourcePartition,
		previousNode: object,
		currentNode: object,
		visiting: Map<object, Set<object>>,
	): boolean => {
		let visited = visiting.get(previousNode);

		if (visited === undefined) {
			visited = new Set();
			visiting.set(previousNode, visited);
		}

		if (visited.has(currentNode)) return false;

		visited.add(currentNode);

		const used = partition.affected.get(previousNode);

		if (used === undefined) {
			if (previousNode !== currentNode) return true;

			const recorded = partition.versionAtRecord.get(previousNode);

			if (recorded === undefined) return true;

			return getProxyVersion(previousNode) !== recorded;
		}

		const keys = used[KEYS_PROPERTY];

		if (keys !== undefined) {
			const stored = partition.prevValues.get(previousNode);

			for (const key of keys) {
				if (!stored?.has(key)) return true;

				const previousValue = stored.get(key);
				const currentValue: unknown = Reflect.get(currentNode, key);

				if (isComparableProxy(previousValue) && isComparableProxy(currentValue)) {
					if (nodeChanged(partition, previousValue, currentValue, visiting)) return true;

					continue;
				}

				if (!Object.is(previousValue, currentValue)) return true;
			}
		}

		const hasKeys = used[HAS_KEY_PROPERTY];

		if (hasKeys !== undefined) {
			const stored = partition.prevHas.get(previousNode);

			for (const key of hasKeys) {
				if (!stored?.has(key)) return true;

				if (Reflect.has(currentNode, key) !== stored.get(key)) return true;
			}
		}

		const hasOwnKeys = used[HAS_OWN_KEY_PROPERTY];

		if (hasOwnKeys !== undefined) {
			const stored = partition.prevHasOwn.get(previousNode);

			for (const key of hasOwnKeys) {
				if (!stored?.has(key)) return true;

				if ((Reflect.getOwnPropertyDescriptor(currentNode, key) !== undefined) !== stored.get(key)) return true;
			}
		}

		if (used[ALL_OWN_KEYS_PROPERTY] === true) {
			const previousKeys = partition.prevOwnKeys.get(previousNode);

			if (previousKeys === undefined) return true;

			const currentKeys = Reflect.ownKeys(currentNode);

			if (currentKeys.length !== previousKeys.length) return true;

			for (let index = 0; index < currentKeys.length; index += 1) {
				if (currentKeys[index] !== previousKeys[index]) return true;
			}
		}

		return false;
	};

	const wrapLive = (liveProxy: object, partition: SourcePartition): object => {
		const currentVersion = getProxyVersion(liveProxy);
		const cached = partition.proxyCache.get(liveProxy);

		if (cached?.version === currentVersion) return cached.wrapper;

		const storageTarget = getProxyTarget(liveProxy);

		const wrapperBox: { current?: object } = {};

		const handler: ProxyHandler<object> = {
			get(_target, prop) {
				const value: unknown = Reflect.get(liveProxy, prop, liveProxy);
				const wrapper = wrapperBox.current;

				const used = trackUsage(partition, liveProxy);

				recordKey(used, KEYS_PROPERTY, prop);
				storeValue(partition, liveProxy, prop, value);

				if (typeof value === "function") {
					const method = getPrototypeMethod(storageTarget, prop);

					if (method !== undefined && value === method && wrapper !== undefined) {
						return bindMethodToWrapper(wrapper, method);
					}
				}

				if (!isObjectLike(value)) return value;

				if (typeof value === "function") return value;

				if (refSet.has(value)) return value;

				if (!isLiveProxy(value)) return value;

				return wrapLive(value, partition);
			},
			has(_target, prop) {
				const used = trackUsage(partition, liveProxy);

				recordKey(used, HAS_KEY_PROPERTY, prop);
				storeHas(partition, liveProxy, prop);

				return Reflect.has(liveProxy, prop);
			},
			getOwnPropertyDescriptor(_target, prop) {
				const used = trackUsage(partition, liveProxy);

				recordKey(used, HAS_OWN_KEY_PROPERTY, prop);
				storeHasOwn(partition, liveProxy, prop);

				return Reflect.getOwnPropertyDescriptor(liveProxy, prop);
			},
			ownKeys() {
				const used = trackUsage(partition, liveProxy);

				used[ALL_OWN_KEYS_PROPERTY] = true;
				storeOwnKeys(partition, liveProxy);

				return Reflect.ownKeys(liveProxy);
			},
			set(_target, prop, value) {
				return Reflect.set(liveProxy, prop, value, liveProxy);
			},
			deleteProperty(_target, prop) {
				return Reflect.deleteProperty(liveProxy, prop);
			},
		};

		const wrapper = new Proxy(liveProxy, handler);

		wrapperBox.current = wrapper;
		registerWrapperTarget(wrapper, liveProxy);
		partition.proxyCache.set(liveProxy, { wrapper, version: currentVersion });

		return wrapper;
	};

	return {
		wrap<T extends object>(sourceProxy: T): T {
			if (!isLiveProxy(sourceProxy)) {
				throw new Error("opshot: Boundary.wrap requires a live Valtio proxy");
			}

			const partition = getPartition(sourceProxy);

			return wrapLive(sourceProxy, partition) as T;
		},

		readsChanged(sourceProxy: object): boolean {
			const partition = partitions.get(sourceProxy);

			if (partition === undefined) return false;

			if (partition.affected.size === 0) return false;

			return nodeChanged(partition, sourceProxy, sourceProxy, new Map());
		},

		captureReads(): void {
			learnNonRenderDispatcher();

			afterRender = true;
		},

		resetReads(): void {
			afterRender = false;

			for (const partition of partitions.values()) {
				partition.affected.clear();
				partition.prevValues.clear();
				partition.prevHas.clear();
				partition.prevHasOwn.clear();
				partition.prevOwnKeys.clear();
				partition.versionAtRecord.clear();
			}
		},

		retain(): void {
			releasing = false;
		},

		dispose(): void {
			releasing = true;

			void Promise.resolve().then(() => {
				if (!releasing) return;

				releasing = false;
				partitions.clear();
			});
		},
	};
}
