import { getVersion, unstable_getInternalStates } from "valtio/vanilla";
import { getRegisteredReadProxyTarget, registerReadProxyTarget } from "../identity";
import { isRendering, learnNonRenderDispatcher } from "./renderPhase";
import type { DirtyIndex } from "../handle";

const { proxyStateMap } = unstable_getInternalStates();

const KEYS_PROPERTY = "k";
const HAS_KEY_PROPERTY = "h";
const HAS_OWN_KEY_PROPERTY = "o";
const ALL_OWN_KEYS_PROPERTY = "w";

const isObjectLike = (value: unknown): value is object =>
	value !== null && (typeof value === "object" || typeof value === "function");
const isLiveProxy = (value: object): value is object => proxyStateMap.has(value);
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
	readonly identityReads: Set<object>;
	readonly proxyCache: WeakMap<object, { readProxy: object; version: number }>;
}

export interface ReadTracker {
	wrap<T extends object>(writeProxy: T): T;

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

export const isReadProxy = (value: unknown): boolean =>
	isObjectLike(value) && getRegisteredReadProxyTarget(value) !== undefined;

const trackerPartitions = new WeakMap<ReadTracker, Map<object, SourcePartition>>();

const recordedKeysOf = (used: UsageRecord): Array<Set<string | symbol>> => {
	const keySets = new Array<Set<string | symbol>>();

	if (used[KEYS_PROPERTY] !== undefined) keySets.push(used[KEYS_PROPERTY]);

	if (used[HAS_KEY_PROPERTY] !== undefined) keySets.push(used[HAS_KEY_PROPERTY]);

	if (used[HAS_OWN_KEY_PROPERTY] !== undefined) keySets.push(used[HAS_OWN_KEY_PROPERTY]);

	return keySets;
};

export function readsIntersectDirty(tracker: ReadTracker, dirty: DirtyIndex): boolean {
	const partitions = trackerPartitions.get(tracker);

	if (partitions === undefined) return false;

	for (const partition of partitions.values()) {
		for (const [writeProxy, used] of partition.affected) {
			const raw = getProxyTarget(writeProxy);
			const edges = dirty.edges.get(raw);

			for (const keys of recordedKeysOf(used)) {
				for (const key of keys) {
					if (edges?.has(key) === true) return true;
				}
			}

			if (used[ALL_OWN_KEYS_PROPERTY] === true && dirty.nodes.has(raw)) return true;
		}

		for (const writeProxy of partition.identityReads) {
			if (partition.affected.has(writeProxy)) continue;

			if (dirty.nodes.has(getProxyTarget(writeProxy))) return true;
		}
	}

	return false;
}

export function createReadTracker(): ReadTracker {
	const partitions = new Map<object, SourcePartition>();
	let afterRender = false;
	let releasing = false;

	const getPartition = (writeProxy: object): SourcePartition => {
		let partition = partitions.get(writeProxy);

		if (partition === undefined) {
			partition = {
				affected: new Map(),
				identityReads: new Set(),
				proxyCache: new WeakMap(),
			};
			partitions.set(writeProxy, partition);
		}

		return partition;
	};

	const shouldRecord = (): boolean => !afterRender || isRendering();

	const trackUsage = (partition: SourcePartition, writeProxy: object): UsageRecord =>
		shouldRecord() ? getUsage(partition.affected, writeProxy) : {};

	const recordIdentity = (partition: SourcePartition, value: unknown): void => {
		if (!shouldRecord()) return;

		if (isObjectLike(value) && isLiveProxy(value)) partition.identityReads.add(value);
	};

	const toReadProxy = <T extends object>(writeProxy: T, partition: SourcePartition): T => {
		const currentVersion = getProxyVersion(writeProxy);
		const cached = partition.proxyCache.get(writeProxy);

		if (cached?.version === currentVersion) return cached.readProxy as T;

		const target = getProxyTarget(writeProxy);

		const readProxyBox: { current?: object } = {};
		const boundMethods = new WeakMap<Function, Function>();

		const bindMethodToReadProxy = (readProxy: object, method: Function): Function => {
			const existing = boundMethods.get(method);

			if (existing !== undefined) return existing;

			const bound = Function.prototype.bind.call(method, readProxy) as Function;

			boundMethods.set(method, bound);

			return bound;
		};

		const handler: ProxyHandler<object> = {
			get(_target, prop) {
				const readProxy = readProxyBox.current;
				const value: unknown = Reflect.get(writeProxy, prop, readProxy ?? writeProxy);

				const used = trackUsage(partition, writeProxy);

				recordKey(used, KEYS_PROPERTY, prop);
				recordIdentity(partition, value);

				if (typeof value === "function") {
					const method = getPrototypeMethod(target, prop);

					if (method !== undefined && value === method && readProxy !== undefined) {
						return bindMethodToReadProxy(readProxy, method);
					}
				}

				if (!isObjectLike(value)) return value;

				if (typeof value === "function") return value;

				if (!isLiveProxy(value)) return value;

				return toReadProxy(value, partition);
			},
			has(_target, prop) {
				const used = trackUsage(partition, writeProxy);

				recordKey(used, HAS_KEY_PROPERTY, prop);

				return Reflect.has(writeProxy, prop);
			},
			getOwnPropertyDescriptor(_target, prop) {
				const used = trackUsage(partition, writeProxy);

				recordKey(used, HAS_OWN_KEY_PROPERTY, prop);

				return Reflect.getOwnPropertyDescriptor(writeProxy, prop);
			},
			ownKeys() {
				const used = trackUsage(partition, writeProxy);

				used[ALL_OWN_KEYS_PROPERTY] = true;

				return Reflect.ownKeys(writeProxy);
			},
			set(_target, prop, value) {
				return Reflect.set(writeProxy, prop, value, writeProxy);
			},
			deleteProperty(_target, prop) {
				return Reflect.deleteProperty(writeProxy, prop);
			},
		};

		const readProxy = new Proxy(writeProxy, handler) as T;

		readProxyBox.current = readProxy;
		registerReadProxyTarget(readProxy, writeProxy);
		partition.proxyCache.set(writeProxy, { readProxy, version: currentVersion });

		return readProxy;
	};

	const tracker: ReadTracker = {
		wrap<T extends object>(writeProxy: T): T {
			if (!isLiveProxy(writeProxy)) {
				throw new Error("opshot: ReadTracker.wrap requires a write proxy");
			}

			const partition = getPartition(writeProxy);

			return toReadProxy(writeProxy, partition);
		},

		captureReads(): void {
			learnNonRenderDispatcher();

			afterRender = true;
		},

		resetReads(): void {
			afterRender = false;

			for (const partition of partitions.values()) {
				partition.affected.clear();
				partition.identityReads.clear();
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

	trackerPartitions.set(tracker, partitions);

	return tracker;
}
