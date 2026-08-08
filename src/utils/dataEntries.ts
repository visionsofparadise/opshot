export interface DataEntry {
	readonly key: string;
	readonly value: unknown;
	readonly writable: boolean;
}

export const walkDataEntries = (value: object): Array<DataEntry> => {
	const entries = new Array<DataEntry>();

	for (const key of Object.keys(value)) {
		if (key === "__proto__") continue;

		const descriptor = Reflect.getOwnPropertyDescriptor(value, key);

		if (!descriptor || !("value" in descriptor)) continue;

		entries.push({ key, value: descriptor.value, writable: descriptor.writable === true });
	}

	return entries;
};

export const carriedOwnKeys = (value: object): Array<string | symbol> =>
	Reflect.ownKeys(value).filter((key) => key !== "__proto__");
