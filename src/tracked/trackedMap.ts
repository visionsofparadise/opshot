import { resolveIdentity } from "../identity";
import { assertMutableFacade, createCollectionData, getCollectionIndex, iterateCollectionData, resetCollectionIndex, updateCollectionIndex } from "./trackedCollection";
import { brandTrackedPrototype } from "./trackedWrapper";

export class TrackedMap<K, V> {
	private data: Array<readonly [K, V] | null> = createCollectionData();
	private declare epoch: number;

	constructor(entries?: Iterable<readonly [K, V]>) {
		Object.defineProperty(this, "epoch", { value: 0, enumerable: false, configurable: false, writable: true });

		if (entries !== undefined) for (const [key, value] of entries) this.set(key, value);
	}

	get size(): number {
		void this.epoch;

		return getCollectionIndex(this.data).slots.size;
	}

	has(key: K): boolean {
		void this.epoch;

		return getCollectionIndex(this.data).slots.has(resolveIdentity(key));
	}

	get(key: K): V | undefined {
		void this.epoch;

		const slot = getCollectionIndex(this.data).slots.get(resolveIdentity(key));

		if (slot === undefined) return undefined;

		const pair = this.data[slot];

		return pair === null || pair === undefined ? undefined : pair[1];
	}

	set(key: K, value: V): this {
		assertMutableFacade(this, "epoch", this.data);

		const index = getCollectionIndex(this.data);
		const slot = index.slots.get(resolveIdentity(key));

		if (slot === undefined) {
			const newSlot = this.data.length;

			this.data.push([key, value]);
			updateCollectionIndex(index, this.data, newSlot);
		} else {
			const pair = this.data[slot];

			if (pair === null || pair === undefined) throw new Error("opshot: TrackedMap cache resolved an empty slot");

			this.data[slot] = [pair[0], value];
			updateCollectionIndex(index, this.data, slot);
		}

		this.epoch += 1;

		return this;
	}

	delete(key: K): boolean {
		assertMutableFacade(this, "epoch", this.data);

		const index = getCollectionIndex(this.data);
		const slot = index.slots.get(resolveIdentity(key));

		if (slot === undefined) return false;

		this.data[slot] = null;
		updateCollectionIndex(index, this.data, slot);
		this.epoch += 1;

		return true;
	}

	clear(): void {
		assertMutableFacade(this, "epoch", this.data);

		this.data = createCollectionData();
		resetCollectionIndex(this.data);
		this.epoch += 1;
	}

	entries(): IterableIterator<[K, V]> {
		void this.epoch;

		const data = iterateCollectionData(() => this.data);

		return (function* () {
			for (const pair of data) yield [pair[0], pair[1]];
		})();
	}

	keys(): IterableIterator<K> {
		void this.epoch;

		const data = iterateCollectionData(() => this.data);

		return (function* () {
			for (const pair of data) yield pair[0];
		})();
	}

	values(): IterableIterator<V> {
		void this.epoch;

		const data = iterateCollectionData(() => this.data);

		return (function* () {
			for (const pair of data) yield pair[1];
		})();
	}

	forEach(callback: (value: V, key: K, map: TrackedMap<K, V>) => void): void {
		void this.epoch;

		for (const pair of iterateCollectionData(() => this.data)) callback(pair[1], pair[0], this);
	}

	[Symbol.iterator](): IterableIterator<[K, V]> {
		void this.epoch;

		return this.entries();
	}

	declare readonly [Symbol.toStringTag]: "TrackedMap";
}

const isTrackedMapData = <K, V>(value: unknown): value is Array<readonly [K, V] | null> => Array.isArray(value);

export const getTrackedMapData = <K, V>(map: object): Array<readonly [K, V] | null> => {
	const data: unknown = Reflect.get(map, "data");

	if (!isTrackedMapData<K, V>(data)) throw new Error("opshot: TrackedMap facade has invalid data backing");

	return data;
};

export const setTrackedMapData = <K, V>(map: object, data: Array<readonly [K, V] | null>): void => {
	const descriptor = Reflect.getOwnPropertyDescriptor(map, "data");

	if (descriptor === undefined || !("value" in descriptor)) throw new Error("opshot: TrackedMap facade has invalid data backing");
	if (!Reflect.defineProperty(map, "data", { ...descriptor, value: data })) throw new Error("opshot: TrackedMap data backing could not be replaced");
};

export const bumpTrackedMapEpoch = (map: object): void => {
	const epoch: unknown = Reflect.get(map, "epoch");

	if (typeof epoch !== "number" || !Reflect.set(map, "epoch", epoch + 1)) throw new Error("opshot: TrackedMap facade has invalid epoch backing");
};

Object.defineProperty(TrackedMap.prototype, Symbol.toStringTag, { value: "TrackedMap", enumerable: false, configurable: false, writable: false });
brandTrackedPrototype(TrackedMap.prototype);
