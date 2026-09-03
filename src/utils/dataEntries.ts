export interface DataEntry {
	readonly key: string;
	readonly value: unknown;
	readonly writable: boolean;
}

export const walkDataEntries = (value: object): Array<DataEntry> => {
	const entries = new Array<DataEntry>();

	for (const key of Reflect.ownKeys(value)) {
		if (typeof key !== "string" || key === "__proto__") continue;

		const descriptor = Reflect.getOwnPropertyDescriptor(value, key);

		if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) continue;

		entries.push({ key, value: descriptor.value, writable: descriptor.writable === true });
	}

	return entries;
};
