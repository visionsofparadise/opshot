import { installBoundary } from "../valtio/boundary";
import { addressOf } from "./address";
import { assertMutableFacade } from "./facadeGuard";
import { iterateSlots } from "./iterateSlots";
import { clearStore, deleteFromStore, type SlotStore } from "./slotStore";

export class TrackedSet<T> {
	private slots: Array<readonly [T] | null>;
	private index: Record<string, number>;
	private count: number;

	constructor(values?: Iterable<T>) {
		installBoundary();

		this.slots = [];
		this.index = {};
		this.count = 0;

		if (values !== undefined) for (const value of values) this.add(value);
	}

	get size(): number {
		return this.count;
	}

	has(value: T): boolean {
		return this.index[addressOf(value)] !== undefined;
	}

	add(value: T): this {
		assertMutableFacade(this, "count");

		const addr = addressOf(value);

		if (this.index[addr] !== undefined) return this;

		const slot = this.slots.length;

		this.slots.push([value]);
		this.index[addr] = slot;
		this.count += 1;

		return this;
	}

	delete(value: T): boolean {
		assertMutableFacade(this, "count");

		return deleteFromStore(this as unknown as SlotStore<readonly [T]>, addressOf(value));
	}

	clear(): void {
		assertMutableFacade(this, "count");
		clearStore(this as unknown as SlotStore<readonly [T]>);
	}

	entries(): IterableIterator<[T, T]> {
		const members = iterateSlots<readonly [T]>(() => this.slots);

		return (function* () {
			for (const member of members) yield [member[0], member[0]];
		})();
	}

	keys(): IterableIterator<T> {
		return this.values();
	}

	values(): IterableIterator<T> {
		const members = iterateSlots<readonly [T]>(() => this.slots);

		return (function* () {
			for (const member of members) yield member[0];
		})();
	}

	forEach(callback: (value: T, key: T, set: TrackedSet<T>) => void): void {
		for (const member of iterateSlots<readonly [T]>(() => this.slots)) callback(member[0], member[0], this);
	}

	[Symbol.iterator](): IterableIterator<T> {
		return this.values();
	}

	declare readonly [Symbol.toStringTag]: "TrackedSet";
}

Object.defineProperty(TrackedSet.prototype, Symbol.toStringTag, {
	value: "TrackedSet",
	enumerable: false,
	configurable: false,
	writable: false,
});
