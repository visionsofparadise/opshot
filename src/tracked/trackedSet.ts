import { resolveIdentity } from "../identity";
import { assertMutableFacade, createCollectionData, getCollectionIndex, iterateCollectionData, resetCollectionIndex, updateCollectionIndex } from "./trackedCollection";
import { brandTrackedPrototype } from "./trackedWrapper";

export class TrackedSet<T> {
	private data: Array<readonly [T] | null> = createCollectionData();
	private declare epoch: number;

	constructor(values?: Iterable<T>) {
		Object.defineProperty(this, "epoch", { value: 0, enumerable: false, configurable: false, writable: true });

		if (values !== undefined) for (const value of values) this.add(value);
	}

	get size(): number {
		void this.epoch;

		return getCollectionIndex(this.data).slots.size;
	}

	has(value: T): boolean {
		void this.epoch;

		return getCollectionIndex(this.data).slots.has(resolveIdentity(value));
	}

	add(value: T): this {
		assertMutableFacade(this, "epoch", this.data);

		const index = getCollectionIndex(this.data);

		if (index.slots.has(resolveIdentity(value))) return this;

		const slot = this.data.length;

		this.data.push([value]);
		updateCollectionIndex(index, this.data, slot);
		this.epoch += 1;

		return this;
	}

	delete(value: T): boolean {
		assertMutableFacade(this, "epoch", this.data);

		const index = getCollectionIndex(this.data);
		const slot = index.slots.get(resolveIdentity(value));

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

	entries(): IterableIterator<[T, T]> {
		void this.epoch;

		const data = iterateCollectionData(() => this.data);

		return (function* () {
			for (const pair of data) yield [pair[0], pair[0]];
		})();
	}

	keys(): IterableIterator<T> {
		void this.epoch;

		return this.values();
	}

	values(): IterableIterator<T> {
		void this.epoch;

		const data = iterateCollectionData(() => this.data);

		return (function* () {
			for (const pair of data) yield pair[0];
		})();
	}

	forEach(callback: (value: T, key: T, set: TrackedSet<T>) => void): void {
		void this.epoch;

		for (const pair of iterateCollectionData(() => this.data)) callback(pair[0], pair[0], this);
	}

	[Symbol.iterator](): IterableIterator<T> {
		void this.epoch;

		return this.values();
	}

	declare readonly [Symbol.toStringTag]: "TrackedSet";
}

const isTrackedSetData = <T>(value: unknown): value is Array<readonly [T] | null> => Array.isArray(value);

export const getTrackedSetData = <T>(set: object): Array<readonly [T] | null> => {
	const data: unknown = Reflect.get(set, "data");

	if (!isTrackedSetData<T>(data)) throw new Error("opshot: TrackedSet facade has invalid data backing");

	return data;
};

export const setTrackedSetData = <T>(set: object, data: Array<readonly [T] | null>): void => {
	const descriptor = Reflect.getOwnPropertyDescriptor(set, "data");

	if (descriptor === undefined || !("value" in descriptor)) throw new Error("opshot: TrackedSet facade has invalid data backing");
	if (!Reflect.defineProperty(set, "data", { ...descriptor, value: data })) throw new Error("opshot: TrackedSet data backing could not be replaced");
};

export const bumpTrackedSetEpoch = (set: object): void => {
	const epoch: unknown = Reflect.get(set, "epoch");

	if (typeof epoch !== "number" || !Reflect.set(set, "epoch", epoch + 1)) throw new Error("opshot: TrackedSet facade has invalid epoch backing");
};

Object.defineProperty(TrackedSet.prototype, Symbol.toStringTag, { value: "TrackedSet", enumerable: false, configurable: false, writable: false });
brandTrackedPrototype(TrackedSet.prototype);
