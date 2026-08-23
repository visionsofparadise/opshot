import { isCanonicalArrayIndexString } from "../ops/predicates";

export interface DataEntry {
	readonly key: string;
	readonly value: unknown;
	readonly writable: boolean;
}

export const walkDataEntries = (value: object, includeArrayLength = false): Array<DataEntry> => {
	const entries = new Array<DataEntry>();

	for (const key of Object.keys(value)) {
		if (key === "__proto__") continue;

		const descriptor = Reflect.getOwnPropertyDescriptor(value, key);

		if (!descriptor || !("value" in descriptor)) continue;

		entries.push({ key, value: descriptor.value, writable: descriptor.writable === true });
	}

	if (includeArrayLength && Array.isArray(value)) {
		const lengthDescriptor = Reflect.getOwnPropertyDescriptor(value, "length");

		entries.push({
			key: "length",
			value: value.length,
			writable: lengthDescriptor?.writable === true,
		});
	}

	return entries;
};

export const segmentFor = (parent: object, key: string): string | number =>
	Array.isArray(parent) && isCanonicalArrayIndexString(key) ? Number(key) : key;

export const dataEntryValuesOf = (value: object, ignoreArrayIndexes: boolean): Map<string, unknown> => {
	const entries = new Map<string, unknown>();

	for (const entry of walkDataEntries(value)) {
		if (ignoreArrayIndexes && isCanonicalArrayIndexString(entry.key)) continue;

		entries.set(entry.key, entry.value);
	}

	return entries;
};

export const carriedOwnKeysOf = (value: object): Array<string | symbol> =>
	Reflect.ownKeys(value).filter((key) => key !== "__proto__");
