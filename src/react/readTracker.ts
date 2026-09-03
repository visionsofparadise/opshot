import { registerReadProxyTarget } from "../identity";
import { recordOf, rawOf } from "../node";
import { isObjectLike } from "../utils/predicates";
import { isRendering, learnNonRenderDispatcher } from "./renderPhase";
import type { DirtyIndex } from "../handle";

const KEYS_PROPERTY = "k";
const HAS_KEY_PROPERTY = "h";
const HAS_OWN_KEY_PROPERTY = "o";
const ALL_OWN_KEYS_PROPERTY = "w";

const isWriteProxy = (value: object): boolean => recordOf(value)?.proxy === value;

interface UsageRecord {
	[KEYS_PROPERTY]?: Map<string | symbol, unknown>;
	[HAS_KEY_PROPERTY]?: Map<string | symbol, boolean>;
	[HAS_OWN_KEY_PROPERTY]?: Map<string | symbol, boolean>;
	[ALL_OWN_KEYS_PROPERTY]?: Array<string | symbol>;
}

interface SourcePartition {
	readonly affected: Map<object, UsageRecord>;
	readonly identityReads: Set<object>;
	proxyCache: WeakMap<object, object>;
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

const recordIn = <T>(
	slot: Map<string | symbol, T> | undefined,
	key: string | symbol,
	value: T,
): Map<string | symbol, T> => {
	const map = slot ?? new Map<string | symbol, T>();

	if (!map.has(key)) map.set(key, value);

	return map;
};

const recordGet = (used: UsageRecord, key: string | symbol, value: unknown): void => {
	used[KEYS_PROPERTY] = recordIn(used[KEYS_PROPERTY], key, value);
};

const recordHas = (used: UsageRecord, key: string | symbol, value: boolean): void => {
	used[HAS_KEY_PROPERTY] = recordIn(used[HAS_KEY_PROPERTY], key, value);
};

const recordOwn = (used: UsageRecord, key: string | symbol, value: boolean): void => {
	used[HAS_OWN_KEY_PROPERTY] = recordIn(used[HAS_OWN_KEY_PROPERTY], key, value);
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

class UnregisteredReadTrackerError extends Error {
	constructor() {
		super("opshot: readsIntersectDirty received an unregistered tracker");
		this.name = "UnregisteredReadTrackerError";
	}
}

const trackerPartitions = new WeakMap<ReadTracker, Map<object, SourcePartition>>();

const partitionsOf = (tracker: ReadTracker): Map<object, SourcePartition> => {
	const partitions = trackerPartitions.get(tracker);

	if (partitions === undefined) throw new UnregisteredReadTrackerError();

	return partitions;
};

const recordedKeysOf = (used: UsageRecord): Array<Map<string | symbol, unknown>> => {
	const keyMaps = new Array<Map<string | symbol, unknown>>();

	if (used[KEYS_PROPERTY] !== undefined) keyMaps.push(used[KEYS_PROPERTY]);

	if (used[HAS_KEY_PROPERTY] !== undefined) keyMaps.push(used[HAS_KEY_PROPERTY]);

	if (used[HAS_OWN_KEY_PROPERTY] !== undefined) keyMaps.push(used[HAS_OWN_KEY_PROPERTY]);

	return keyMaps;
};

export function readsIntersectDirty(tracker: ReadTracker, dirty: DirtyIndex): boolean {
	for (const partition of partitionsOf(tracker).values()) {
		for (const [writeProxy, used] of partition.affected) {
			const raw = rawOf(writeProxy);
			const edges = dirty.edges.get(raw);

			for (const keys of recordedKeysOf(used)) {
				for (const key of keys.keys()) {
					if (typeof key === "symbol") continue;

					if (edges?.has(key) === true) return true;
				}
			}

			if (used[ALL_OWN_KEYS_PROPERTY] !== undefined && dirty.nodes.has(raw)) return true;
		}

		for (const writeProxy of partition.identityReads) {
			if (partition.affected.has(writeProxy)) continue;

			if (dirty.nodes.has(rawOf(writeProxy))) return true;
		}
	}

	return false;
}

export function readsChanged(tracker: ReadTracker): boolean {
	for (const partition of partitionsOf(tracker).values()) {
		for (const [writeProxy, used] of partition.affected) {
			const gets = used[KEYS_PROPERTY];

			if (gets !== undefined) {
				for (const [key, stored] of gets) {
					if (!Object.is(Reflect.get(writeProxy, key, writeProxy), stored)) return true;
				}
			}

			const hasKeys = used[HAS_KEY_PROPERTY];

			if (hasKeys !== undefined) {
				for (const [key, stored] of hasKeys) {
					if (!Object.is(Reflect.has(writeProxy, key), stored)) return true;
				}
			}

			const ownKeys = used[HAS_OWN_KEY_PROPERTY];

			if (ownKeys !== undefined) {
				for (const [key, stored] of ownKeys) {
					const present = Reflect.getOwnPropertyDescriptor(writeProxy, key) !== undefined;

					if (!Object.is(present, stored)) return true;
				}
			}

			const listed = used[ALL_OWN_KEYS_PROPERTY];

			if (listed !== undefined) {
				const current = Reflect.ownKeys(writeProxy);

				if (current.length !== listed.length) return true;

				for (let index = 0; index < listed.length; index += 1) {
					if (!Object.is(current[index], listed[index])) return true;
				}
			}
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

		if (isObjectLike(value) && isWriteProxy(value)) partition.identityReads.add(value);
	};

	const toReadProxy = <T extends object>(writeProxy: T, partition: SourcePartition): T => {
		const raw = rawOf(writeProxy);
		const cached = partition.proxyCache.get(raw);

		if (cached !== undefined) return cached as T;

		const target = raw;

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

				recordGet(used, prop, value);
				recordIdentity(partition, value);

				if (typeof value === "function") {
					const method = getPrototypeMethod(target, prop);

					if (method !== undefined && value === method && readProxy !== undefined) {
						return bindMethodToReadProxy(readProxy, method);
					}
				}

				if (!isObjectLike(value)) return value;

				if (typeof value === "function") return value;

				if (!isWriteProxy(value)) return value;

				return toReadProxy(value, partition);
			},
			has(_target, prop) {
				const used = trackUsage(partition, writeProxy);
				const result = Reflect.has(writeProxy, prop);

				recordHas(used, prop, result);

				return result;
			},
			getOwnPropertyDescriptor(_target, prop) {
				const used = trackUsage(partition, writeProxy);
				const descriptor = Reflect.getOwnPropertyDescriptor(writeProxy, prop);

				recordOwn(used, prop, descriptor !== undefined);

				return descriptor;
			},
			ownKeys() {
				const used = trackUsage(partition, writeProxy);
				const keys = Reflect.ownKeys(writeProxy);

				used[ALL_OWN_KEYS_PROPERTY] ??= keys;

				return keys;
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
		partition.proxyCache.set(raw, readProxy);

		return readProxy;
	};

	const tracker: ReadTracker = {
		wrap<T extends object>(writeProxy: T): T {
			if (!isWriteProxy(writeProxy)) {
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
				partition.proxyCache = new WeakMap();
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
