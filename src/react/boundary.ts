import { isChanged } from "proxy-compare";
import { snapshot, unstable_getInternalStates } from "valtio/vanilla";
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

interface UsageRecord {
	[KEYS_PROPERTY]?: Set<string | symbol>;
	[HAS_KEY_PROPERTY]?: Set<string | symbol>;
	[HAS_OWN_KEY_PROPERTY]?: Set<string | symbol>;
	[ALL_OWN_KEYS_PROPERTY]?: true;
}

interface SourcePartition {
	readonly sourceProxy: object;
	previousRootSnapshot: object | undefined;
	readonly affected: Map<object, UsageRecord>;
	readonly baselines: Map<object, object>;
	readonly proxyCache: WeakMap<object, object>;
}

interface CacheTarget {
	lastIdentitySnapshot: object;
}

export interface Boundary {
	wrap<T extends object>(sourceProxy: T): T;

	readsChanged(sourceProxy: object): boolean;

	evictChangedTargets(): void;

	resetReads(): void;
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
	const targets = new Map<object, CacheTarget>();

	const getPartition = (sourceProxy: object): SourcePartition => {
		let partition = partitions.get(sourceProxy);

		if (partition === undefined) {
			partition = {
				sourceProxy,
				previousRootSnapshot: undefined,
				affected: new Map(),
				baselines: new Map(),
				proxyCache: new WeakMap(),
			};
			partitions.set(sourceProxy, partition);
		}

		return partition;
	};

	const ensureBaseline = (partition: SourcePartition, liveProxy: object): object => {
		const existing = partition.baselines.get(liveProxy);

		if (existing !== undefined) return existing;

		const baseline = snapshot(liveProxy);

		partition.baselines.set(liveProxy, baseline);

		return baseline;
	};

	const ensureRootBaseline = (partition: SourcePartition): object => {
		if (partition.previousRootSnapshot === undefined) {
			partition.previousRootSnapshot = snapshot(partition.sourceProxy);
			partition.baselines.set(partition.sourceProxy, partition.previousRootSnapshot);
		}

		return partition.previousRootSnapshot;
	};

	const registerTarget = (liveProxy: object): void => {
		if (targets.has(liveProxy)) return;

		targets.set(liveProxy, {
			lastIdentitySnapshot: snapshot(liveProxy),
		});
	};

	const wrapLive = (liveProxy: object, partition: SourcePartition): object => {
		ensureBaseline(partition, liveProxy);
		registerTarget(liveProxy);

		const cached = partition.proxyCache.get(liveProxy);

		if (cached !== undefined) return cached;

		const storageTarget = getProxyTarget(liveProxy);

		const wrapperBox: { current?: object } = {};

		const handler: ProxyHandler<object> = {
			get(_target, prop) {
				ensureRootBaseline(partition);

				const value: unknown = Reflect.get(liveProxy, prop, liveProxy);
				const wrapper = wrapperBox.current;

				const used = getUsage(partition.affected, liveProxy);

				recordKey(used, KEYS_PROPERTY, prop);
				ensureBaseline(partition, liveProxy);

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
				const used = getUsage(partition.affected, liveProxy);

				recordKey(used, HAS_KEY_PROPERTY, prop);
				ensureBaseline(partition, liveProxy);

				return Reflect.has(liveProxy, prop);
			},
			getOwnPropertyDescriptor(_target, prop) {
				const used = getUsage(partition.affected, liveProxy);

				recordKey(used, HAS_OWN_KEY_PROPERTY, prop);
				ensureBaseline(partition, liveProxy);

				return Reflect.getOwnPropertyDescriptor(liveProxy, prop);
			},
			ownKeys() {
				const used = getUsage(partition.affected, liveProxy);

				used[ALL_OWN_KEYS_PROPERTY] = true;
				ensureBaseline(partition, liveProxy);

				return Reflect.ownKeys(liveProxy);
			},
			set(_target, prop, value) {
				ensureRootBaseline(partition);

				return Reflect.set(liveProxy, prop, value, liveProxy);
			},
			deleteProperty(_target, prop) {
				ensureRootBaseline(partition);

				return Reflect.deleteProperty(liveProxy, prop);
			},
		};

		const wrapper = new Proxy(Object.create(null) as object, handler);

		wrapperBox.current = wrapper;
		registerWrapperTarget(wrapper, liveProxy);
		partition.proxyCache.set(liveProxy, wrapper);

		return wrapper;
	};

	return {
		wrap<T extends object>(sourceProxy: T): T {
			if (!isLiveProxy(sourceProxy)) {
				throw new Error("opshot: Boundary.wrap requires a live Valtio proxy");
			}

			const partition = getPartition(sourceProxy);

			ensureRootBaseline(partition);

			return wrapLive(sourceProxy, partition) as T;
		},

		readsChanged(sourceProxy: object): boolean {
			const partition = partitions.get(sourceProxy);

			if (partition?.previousRootSnapshot === undefined) return false;

			if (partition.affected.size === 0) return false;

			const translated = new WeakMap<object, UsageRecord>();

			for (const [live, usage] of partition.affected) {
				const baseline = partition.baselines.get(live);

				if (baseline === undefined) {
					throw new Error("opshot: missing baseline snapshot for affected live proxy");
				}

				translated.set(baseline, usage);
			}

			const nextRoot = snapshot(sourceProxy);

			return isChanged(partition.previousRootSnapshot, nextRoot, translated, new WeakMap());
		},

		evictChangedTargets(): void {
			for (const [liveProxy, entry] of targets) {
				const current = snapshot(liveProxy);

				if (current !== entry.lastIdentitySnapshot) {
					for (const partition of partitions.values()) {
						partition.proxyCache.delete(liveProxy);
					}
				}

				entry.lastIdentitySnapshot = current;
			}
		},

		resetReads(): void {
			for (const partition of partitions.values()) {
				partition.previousRootSnapshot = undefined;
				partition.affected.clear();
				partition.baselines.clear();
			}
		},
	};
}
