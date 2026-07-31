import { installBoundary } from "../valtio/boundary";
import { addressOf } from "./address";
import { assertMutableFacade } from "./facadeGuard";
import { iterateSlots } from "./iterateSlots";
import { clearStore, deleteFromStore, type SlotStore } from "./slotStore";

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

		const addr = addressOf(key);
		const slot = this.index[addr];

		if (slot === undefined) {
			const newSlot = this.slots.length;

			this.slots.push([key, value]);
			this.index[addr] = newSlot;
			this.count += 1;
		} else {
			const pair = this.slots[slot];

			if (pair === null || pair === undefined) throw new Error("opshot: TrackedMap resolved an empty slot");

			this.slots[slot] = [pair[0], value];
		}

		return this;
	}

	delete(key: K): boolean {
		assertMutableFacade(this, "count");

		return deleteFromStore(this as unknown as SlotStore<readonly [K, V]>, addressOf(key));
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
