import { translateCursor } from "./slotStore";

export function* iterateSlots<T>(getSlots: () => ReadonlyArray<T | null>): IterableIterator<T> {
	let slots = getSlots();
	let index = 0;

	for (;;) {
		const current = getSlots();

		if (current !== slots) {
			index = translateCursor(slots, index, current);
			slots = current;
		}

		if (index >= slots.length) return;

		const entry = slots[index];

		index += 1;

		if (entry !== null && entry !== undefined) yield entry;
	}
}
