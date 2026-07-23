// Live iteration over a facade's slot array, matching native Map/Set semantics:
// re-read the slots each step so entries added during iteration are visited, deleted
// slots (tombstones) are skipped, and a clear() that reassigns the array terminates.
export function* iterateSlots<T>(getSlots: () => ReadonlyArray<T | null>): IterableIterator<T> {
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
}
