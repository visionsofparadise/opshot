import { getUntracked } from "proxy-compare";
import { proxy } from "valtio/vanilla";

import { getRegisteredTarget, resolveIdentity } from "../identity";
import { getDirectWriteGeneration, getDirectWriteVersion, installBoundary, type DirectWriteGeneration } from "../valtio/boundary";

installBoundary();

export type TrackedCollectionEntry = readonly [unknown, ...Array<unknown>] | null;

export interface CollectionIndex {
	data: object;
	version: number | undefined;
	generation: DirectWriteGeneration | undefined;
	readonly slots: Map<unknown, number>;
	readonly identities: Array<unknown>;
}

const tombstone = Symbol("opshot.collection.tombstone");
const indexes = new WeakMap<DirectWriteGeneration, CollectionIndex>();

const getEntryIdentity = (entry: TrackedCollectionEntry | undefined): unknown => (entry === null || entry === undefined ? tombstone : resolveIdentity(entry[0]));

const buildIndex = (data: ReadonlyArray<TrackedCollectionEntry>, generation = getDirectWriteGeneration(data)): CollectionIndex => {
	const slots = new Map<unknown, number>();
	const identities = new Array<unknown>(data.length);

	for (let slot = 0; slot < data.length; slot++) {
		const identity = getEntryIdentity(data[slot]);

		identities[slot] = identity;
		if (identity !== tombstone) slots.set(identity, slot);
	}

	return { data, version: generation?.version, generation, slots, identities };
};

export const createCollectionData = <T extends TrackedCollectionEntry>(): Array<T> => {
	const data = proxy(new Array<T>());

	void getDirectWriteVersion(data);

	return data;
};

export const assertMutableFacade = (facade: object, mutationKey: PropertyKey, backing?: object): void => {
	const facadeSource = getUntracked(facade);
	const backingSource = backing === undefined ? null : getUntracked(backing);
	const isRegisteredCopy =
		getRegisteredTarget(facade) !== undefined ||
		(facadeSource !== null && getRegisteredTarget(facadeSource) !== undefined) ||
		(backing !== undefined && getRegisteredTarget(backing) !== undefined) ||
		(backingSource !== null && getRegisteredTarget(backingSource) !== undefined);
	const descriptor = Reflect.getOwnPropertyDescriptor(facade, mutationKey);

	if (isRegisteredCopy || (descriptor !== undefined && "writable" in descriptor && !descriptor.writable)) {
		throw new Error("opshot: cannot mutate a tracked collection snapshot");
	}
};

export const getCollectionIndex = (data: ReadonlyArray<TrackedCollectionEntry>): CollectionIndex => {
	const generation = getDirectWriteGeneration(data);

	if (generation === undefined) return buildIndex(data, undefined);

	const cached = indexes.get(generation);

	if (cached !== undefined) return cached;

	const index = buildIndex(data, generation);

	indexes.set(generation, index);

	return index;
};

export const updateCollectionIndex = (index: CollectionIndex, data: ReadonlyArray<TrackedCollectionEntry>, slot: number): void => {
	const generation = getDirectWriteGeneration(data);
	const current = index;

	if (generation !== undefined && index.generation !== generation) {
		if (index.generation !== undefined) indexes.delete(index.generation);

		index.generation = generation;
		index.version = generation.version;
		indexes.set(generation, index);
	}

	if (slot < current.identities.length) {
		const priorIdentity = current.identities[slot];

		if (priorIdentity !== tombstone) current.slots.delete(priorIdentity);
	}

	const identity = getEntryIdentity(data[slot]);

	current.data = data;
	current.version = generation?.version;
	current.generation = generation;
	current.identities[slot] = identity;
	current.identities.length = data.length;

	if (identity !== tombstone) current.slots.set(identity, slot);
};

export const resetCollectionIndex = (data: ReadonlyArray<TrackedCollectionEntry>): void => {
	const generation = getDirectWriteGeneration(data);

	if (generation !== undefined) indexes.set(generation, buildIndex(data, generation));
};

export function* iterateCollectionData<T extends readonly [unknown, ...Array<unknown>]>(getData: () => Array<T | null>): IterableIterator<T> {
	let data = getData();
	let slot = 0;

	for (;;) {
		const current = getData();

		if (current !== data) {
			data = current;
			slot = 0;
		}

		if (slot >= data.length) return;

		const entry = data[slot];

		slot += 1;

		if (entry !== null && entry !== undefined) yield entry;
	}
}
