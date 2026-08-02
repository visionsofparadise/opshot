import { beginIteration, endIteration } from "./slotStore";

export function* iterateSlots<T>(owner: object, getSlots: () => ReadonlyArray<T | null>): IterableIterator<T> {
	beginIteration(owner);

	try {
		let slots = getSlots();
		let index = 0;

		for (;;) {
			const current = getSlots();

			if (current !== slots) {
				slots = current;
				index = 0;
			}

			if (index >= slots.length) return;

			const entry = slots[index];

			index += 1;

			if (entry !== null && entry !== undefined) yield entry;
		}
	} finally {
		endIteration(owner);
	}
}
