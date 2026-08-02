export interface SlotStore<T> {
	slots: Array<T | null>;
	index: Record<string, number>;
	count: number;
}

const activeIterations = new WeakMap<object, number>();

export const beginIteration = (owner: object): void => {
	activeIterations.set(owner, (activeIterations.get(owner) ?? 0) + 1);
};

export const endIteration = (owner: object): void => {
	const remaining = (activeIterations.get(owner) ?? 1) - 1;

	if (remaining > 0) activeIterations.set(owner, remaining);
	else activeIterations.delete(owner);
};

const compactStore = <T>(store: SlotStore<T>, addressOfEntry: (entry: T) => string): void => {
	const slots = new Array<T | null>();
	const index: Record<string, number> = {};

	for (const entry of store.slots) {
		if (entry === null || entry === undefined) continue;

		index[addressOfEntry(entry)] = slots.length;
		slots.push(entry);
	}

	store.slots = slots;
	store.index = index;
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

	if (store.slots.length >= 2 * store.count && !activeIterations.has(store)) {
		compactStore(store, addressOfEntry);
	}

	return true;
};

export const clearStore = <T>(store: SlotStore<T>): void => {
	store.slots = [];
	store.index = {};
	store.count = 0;
};
