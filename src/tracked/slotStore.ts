export interface SlotStore<T> {
	slots: Array<T | null>;
	index: Record<string, number>;
	count: number;
}

export const deleteFromStore = <T>(store: SlotStore<T>, addr: string): boolean => {
	const slot = store.index[addr];

	if (slot === undefined) return false;

	store.slots[slot] = null;
	Reflect.deleteProperty(store.index, addr);
	store.count -= 1;

	return true;
};

export const clearStore = <T>(store: SlotStore<T>): void => {
	store.slots = [];
	store.index = {};
	store.count = 0;
};
