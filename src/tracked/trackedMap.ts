import { isSameIdentity } from "../identity";
import { installBoundary } from "../valtio/boundary";
import { addressOf } from "./address";
import { assertMutableFacade } from "./facadeGuard";
import { iterateSlots } from "./iterateSlots";
import { clearStore, deleteFromStore, type SlotStore } from "./slotStore";

const isObjectLike = (value: unknown): value is object =>
	value !== null && (typeof value === "object" || typeof value === "function");

const isStoredValue = (stored: unknown, incoming: unknown): boolean => {
	if (Object.is(stored, incoming)) return true;

	return isObjectLike(stored) && isObjectLike(incoming) && isSameIdentity(stored, incoming);
};

/**
 * Tracked `Map` for use in state.
 *
 * @typeParam K - Key type.
 * @typeParam V - Value type.
 */
export class TrackedMap<K, V> {
	private slots: Array<readonly [K, V] | null>;
	private index: Record<string, number>;
	private count: number;

	constructor(entries?: Iterable<readonly [K, V]>) {
		installBoundary();

		this.slots = [];
		this.index = {};
		this.count = 0;

		if (entries !== undefined) for (const [key, value] of entries) this.set(key, value);
	}

	get size(): number {
		return this.count;
	}

	has(key: K): boolean {
		return this.index[addressOf(key)] !== undefined;
	}

	get(key: K): V | undefined {
		const slot = this.index[addressOf(key)];

		if (slot === undefined) return undefined;

		const pair = this.slots[slot];

		return pair === null || pair === undefined ? undefined : pair[1];
	}

	set(key: K, value: V): this {
		assertMutableFacade(this, "count");

		const stored = Object.is(key, -0) ? (0 as K) : key;
		const addr = addressOf(stored);
		const slot = this.index[addr];

		if (slot === undefined) {
			const newSlot = this.slots.length;

			this.slots.push([stored, value]);
			this.index[addr] = newSlot;
			this.count += 1;
		} else {
			const pair = this.slots[slot];

			if (pair === null || pair === undefined) throw new Error("opshot: TrackedMap resolved an empty slot");

			if (isStoredValue(pair[1], value)) return this;

			this.slots[slot] = [pair[0], value];
		}

		return this;
	}

	delete(key: K): boolean {
		assertMutableFacade(this, "count");

		return deleteFromStore(this as unknown as SlotStore<readonly [K, V]>, addressOf(key), (pair) =>
			addressOf(pair[0]),
		);
	}

	clear(): void {
		assertMutableFacade(this, "count");
		clearStore(this as unknown as SlotStore<readonly [K, V]>);
	}

	entries(): IterableIterator<[K, V]> {
		const pairs = iterateSlots<readonly [K, V]>(() => this.slots);

		return (function* () {
			for (const pair of pairs) yield [pair[0], pair[1]];
		})();
	}

	keys(): IterableIterator<K> {
		const pairs = iterateSlots<readonly [K, V]>(() => this.slots);

		return (function* () {
			for (const pair of pairs) yield pair[0];
		})();
	}

	values(): IterableIterator<V> {
		const pairs = iterateSlots<readonly [K, V]>(() => this.slots);

		return (function* () {
			for (const pair of pairs) yield pair[1];
		})();
	}

	forEach(callback: (value: V, key: K, map: TrackedMap<K, V>) => void): void {
		for (const pair of iterateSlots<readonly [K, V]>(() => this.slots)) callback(pair[1], pair[0], this);
	}

	[Symbol.iterator](): IterableIterator<[K, V]> {
		return this.entries();
	}

	declare readonly [Symbol.toStringTag]: "TrackedMap";
}

Object.defineProperty(TrackedMap.prototype, Symbol.toStringTag, {
	value: "TrackedMap",
	enumerable: false,
	configurable: false,
	writable: false,
});
