export interface SlotStore<T> {
	slots: Array<T | null>;
	index: Record<string, number>;
	count: number;
}

const swapChain = new WeakMap<object, ReadonlyArray<unknown>>();

const compactStore = <T>(store: SlotStore<T>, addressOfEntry: (entry: T) => string): void => {
	const retired = store.slots;
	const slots = new Array<T | null>();
	const index: Record<string, number> = {};

	for (const entry of retired) {
		if (entry === null || entry === undefined) continue;

		index[addressOfEntry(entry)] = slots.length;
		slots.push(entry);
	}

	store.slots = slots;
	store.index = index;
	swapChain.set(retired, store.slots);
};

export const translateCursor = (
	retired: ReadonlyArray<unknown>,
	cursor: number,
	current: ReadonlyArray<unknown>,
): number => {
	let array: ReadonlyArray<unknown> = retired;
	let position = cursor;

	while (array !== current) {
		const successor = swapChain.get(array);

		if (successor === undefined) return 0;

		let survivors = 0;
		const bound = Math.min(position, array.length);

		for (let slot = 0; slot < bound; slot += 1) {
			const entry = array[slot];

			if (entry !== null && entry !== undefined) survivors += 1;
		}

		position = survivors;
		array = successor;
	}

	return position;
};

export const deleteFromStore = <T>(
	store: SlotStore<T>,
	addr: string,
	addressOfEntry: (entry: T) => string,
): boolean => {
	const slot = store.index[addr];

	if (slot === undefined) return false;

	store.slots[slot] = null;
	Reflect.deleteProperty(store.index, addr);
	store.count -= 1;

	if (store.slots.length >= 2 * store.count) {
		compactStore(store, addressOfEntry);
	}

	return true;
};

export const clearStore = <T>(store: SlotStore<T>): void => {
	store.slots = [];
	store.index = {};
	store.count = 0;
};
