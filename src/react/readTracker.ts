import { getVersion, unstable_getInternalStates } from "valtio/vanilla";
import { getRegisteredReadProxyTarget, registerReadProxyTarget } from "./readProxyRegistry";
import { isRendering, learnNonRenderDispatcher } from "./renderPhase";

const { refSet, proxyStateMap } = unstable_getInternalStates();

const KEYS_PROPERTY = "k";
const HAS_KEY_PROPERTY = "h";
const HAS_OWN_KEY_PROPERTY = "o";
const ALL_OWN_KEYS_PROPERTY = "w";

const isObjectLike = (value: unknown): value is object =>
	value !== null && (typeof value === "object" || typeof value === "function");
const isLiveProxy = (value: object): boolean => proxyStateMap.has(value);
const getProxyTarget = (writeProxy: object): object => proxyStateMap.get(writeProxy)?.[0] ?? writeProxy;
const getProxyVersion = (writeProxy: object): number => getVersion(writeProxy) ?? 0;

interface UsageRecord {
	[KEYS_PROPERTY]?: Set<string | symbol>;
	[HAS_KEY_PROPERTY]?: Set<string | symbol>;
	[HAS_OWN_KEY_PROPERTY]?: Set<string | symbol>;
	[ALL_OWN_KEYS_PROPERTY]?: true;
}

interface SourcePartition {
	readonly affected: Map<object, UsageRecord>;
	readonly previousValues: Map<object, Map<string | symbol, unknown>>;
	readonly previousHas: Map<object, Map<string | symbol, boolean>>;
	readonly previousHasOwn: Map<object, Map<string | symbol, boolean>>;
	readonly previousOwnKeys: Map<object, ReadonlyArray<string | symbol>>;
	readonly versionAtRecord: Map<object, number>;
	readonly proxyCache: WeakMap<object, { readProxy: object; version: number }>;
}

export interface ReadTracker {
	wrap<T extends object>(writeProxy: T): T;

	readsChanged(writeProxy: object): boolean;

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

const readProxyBoundMethods = new WeakMap<object, WeakMap<Function, Function>>();

const bindMethodToReadProxy = (readProxy: object, method: Function): Function => {
	let methods = readProxyBoundMethods.get(readProxy);

	if (methods === undefined) {
		methods = new WeakMap();
		readProxyBoundMethods.set(readProxy, methods);
	}

	const existing = methods.get(method);

	if (existing !== undefined) return existing;

	const bound = Function.prototype.bind.call(method, readProxy) as Function;

	methods.set(method, bound);

	return bound;
};

export const isReadProxy = (value: unknown): boolean =>
	isObjectLike(value) && getRegisteredReadProxyTarget(value) !== undefined;

export function createReadTracker(): ReadTracker {
	const partitions = new Map<object, SourcePartition>();
	let afterRender = false;
	let releasing = false;

	const getPartition = (writeProxy: object): SourcePartition => {
		let partition = partitions.get(writeProxy);

		if (partition === undefined) {
			partition = {
				affected: new Map(),
				previousValues: new Map(),
				previousHas: new Map(),
				previousHasOwn: new Map(),
				previousOwnKeys: new Map(),
				versionAtRecord: new Map(),
				proxyCache: new WeakMap(),
			};
			partitions.set(writeProxy, partition);
		}

		return partition;
	};

	const shouldRecord = (): boolean => !afterRender || isRendering();

	const trackUsage = (partition: SourcePartition, writeProxy: object): UsageRecord =>
		shouldRecord() ? getUsage(partition.affected, writeProxy) : {};

	const storeValue = (partition: SourcePartition, writeProxy: object, key: string | symbol, value: unknown): void => {
		if (!shouldRecord()) return;

		storeFirst(partition.previousValues, writeProxy, key, value);

		if (isObjectLike(value) && isLiveProxy(value) && !partition.versionAtRecord.has(value)) {
			partition.versionAtRecord.set(value, getProxyVersion(value));
		}
	};

	const storeHas = (partition: SourcePartition, writeProxy: object, key: string | symbol): void => {
		if (!shouldRecord()) return;

		storeFirst(partition.previousHas, writeProxy, key, Reflect.has(writeProxy, key));
	};

	const storeHasOwn = (partition: SourcePartition, writeProxy: object, key: string | symbol): void => {
		if (!shouldRecord()) return;

		storeFirst(
			partition.previousHasOwn,
			writeProxy,
			key,
			Reflect.getOwnPropertyDescriptor(writeProxy, key) !== undefined,
		);
	};

	const storeOwnKeys = (partition: SourcePartition, writeProxy: object): void => {
		if (!shouldRecord()) return;

		if (partition.previousOwnKeys.has(writeProxy)) return;

		partition.previousOwnKeys.set(writeProxy, Reflect.ownKeys(writeProxy));
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
			const stored = partition.previousValues.get(previousNode);

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
			const stored = partition.previousHas.get(previousNode);

			for (const key of hasKeys) {
				if (!stored?.has(key)) return true;

				if (Reflect.has(currentNode, key) !== stored.get(key)) return true;
			}
		}

		const hasOwnKeys = used[HAS_OWN_KEY_PROPERTY];

		if (hasOwnKeys !== undefined) {
			const stored = partition.previousHasOwn.get(previousNode);

			for (const key of hasOwnKeys) {
				if (!stored?.has(key)) return true;

				if ((Reflect.getOwnPropertyDescriptor(currentNode, key) !== undefined) !== stored.get(key)) return true;
			}
		}

		if (used[ALL_OWN_KEYS_PROPERTY] === true) {
			const previousKeys = partition.previousOwnKeys.get(previousNode);

			if (previousKeys === undefined) return true;

			const currentKeys = Reflect.ownKeys(currentNode);

			if (currentKeys.length !== previousKeys.length) return true;

			for (let index = 0; index < currentKeys.length; index += 1) {
				if (currentKeys[index] !== previousKeys[index]) return true;
			}
		}

		return false;
	};

	const toReadProxy = (writeProxy: object, partition: SourcePartition): object => {
		const currentVersion = getProxyVersion(writeProxy);
		const cached = partition.proxyCache.get(writeProxy);

		if (cached?.version === currentVersion) return cached.readProxy;

		const target = getProxyTarget(writeProxy);

		const readProxyBox: { current?: object } = {};

		const handler: ProxyHandler<object> = {
			get(_target, prop) {
				const value: unknown = Reflect.get(writeProxy, prop, writeProxy);
				const readProxy = readProxyBox.current;

				const used = trackUsage(partition, writeProxy);

				recordKey(used, KEYS_PROPERTY, prop);
				storeValue(partition, writeProxy, prop, value);

				if (typeof value === "function") {
					const method = getPrototypeMethod(target, prop);

					if (method !== undefined && value === method && readProxy !== undefined) {
						return bindMethodToReadProxy(readProxy, method);
					}
				}

				if (!isObjectLike(value)) return value;

				if (typeof value === "function") return value;

				if (refSet.has(value)) return value;

				if (!isLiveProxy(value)) return value;

				return toReadProxy(value, partition);
			},
			has(_target, prop) {
				const used = trackUsage(partition, writeProxy);

				recordKey(used, HAS_KEY_PROPERTY, prop);
				storeHas(partition, writeProxy, prop);

				return Reflect.has(writeProxy, prop);
			},
			getOwnPropertyDescriptor(_target, prop) {
				const used = trackUsage(partition, writeProxy);

				recordKey(used, HAS_OWN_KEY_PROPERTY, prop);
				storeHasOwn(partition, writeProxy, prop);

				return Reflect.getOwnPropertyDescriptor(writeProxy, prop);
			},
			ownKeys() {
				const used = trackUsage(partition, writeProxy);

				used[ALL_OWN_KEYS_PROPERTY] = true;
				storeOwnKeys(partition, writeProxy);

				return Reflect.ownKeys(writeProxy);
			},
			set(_target, prop, value) {
				return Reflect.set(writeProxy, prop, value, writeProxy);
			},
			deleteProperty(_target, prop) {
				return Reflect.deleteProperty(writeProxy, prop);
			},
		};

		const readProxy = new Proxy(writeProxy, handler);

		readProxyBox.current = readProxy;
		registerReadProxyTarget(readProxy, writeProxy);
		partition.proxyCache.set(writeProxy, { readProxy, version: currentVersion });

		return readProxy;
	};

	return {
		wrap<T extends object>(writeProxy: T): T {
			if (!isLiveProxy(writeProxy)) {
				throw new Error("opshot: ReadTracker.wrap requires a write proxy");
			}

			const partition = getPartition(writeProxy);

			return toReadProxy(writeProxy, partition) as T;
		},

		readsChanged(writeProxy: object): boolean {
			const partition = partitions.get(writeProxy);

			if (partition === undefined) return false;

			if (partition.affected.size === 0) return false;

			return nodeChanged(partition, writeProxy, writeProxy, new Map());
		},

		captureReads(): void {
			learnNonRenderDispatcher();

			afterRender = true;
		},

		resetReads(): void {
			afterRender = false;

			for (const partition of partitions.values()) {
				partition.affected.clear();
				partition.previousValues.clear();
				partition.previousHas.clear();
				partition.previousHasOwn.clear();
				partition.previousOwnKeys.clear();
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
