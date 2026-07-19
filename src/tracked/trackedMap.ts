import { cloneValue, isCloneable } from "../ops/cloneValue";
import { brandTrackedPrototype, getAttachments, notifyAttachments, trackedBrand } from "./trackedWrapper";

// Keys are never cloned: replay addresses the map through them by identity.
const materializeValue = (value: unknown): unknown => (isCloneable(value) ? cloneValue(value, new WeakMap(), "a TrackedMap value") : value);

const materializeEntries = (entries: ReadonlyArray<readonly [unknown, unknown]>): ReadonlyArray<readonly [unknown, unknown]> => {
	const memo = new WeakMap<object, unknown>();

	return entries.map(([key, value]) => [key, isCloneable(value) ? cloneValue(value, memo, "a TrackedMap value") : value] as const);
};

export class TrackedMap<K, V> extends Map<K, V> {
	declare readonly [trackedBrand]: true;

	override set(key: K, value: V): this {
		const notifiers = getAttachments(this);

		if (!notifiers) return super.set(key, value);

		const had = this.has(key);

		if (had && Object.is(this.get(key), value)) return super.set(key, value);

		const priorValue = had ? materializeValue(this.get(key)) : undefined;
		const nextValue = materializeValue(value);

		super.set(key, value);

		notifyAttachments(notifiers, {
			path: [],
			payload: { do: { kind: "mapSet", key, value: nextValue }, undo: had ? { kind: "mapSet", key, value: priorValue } : { kind: "mapDelete", key } },
		});

		return this;
	}

	override delete(key: K): boolean {
		const notifiers = getAttachments(this);

		if (!notifiers || !this.has(key)) return super.delete(key);

		const prior = materializeValue(this.get(key));
		const deleted = super.delete(key);

		notifyAttachments(notifiers, { path: [], payload: { do: { kind: "mapDelete", key }, undo: { kind: "mapSet", key, value: prior } } });

		return deleted;
	}

	override clear(): void {
		const notifiers = getAttachments(this);

		if (!notifiers || this.size === 0) {
			super.clear();

			return;
		}

		const before = materializeEntries([...this.entries()]);

		super.clear();

		notifyAttachments(notifiers, { path: [], payload: { do: { kind: "mapEntries", entries: [] }, undo: { kind: "mapEntries", entries: before } } });
	}
}

brandTrackedPrototype(TrackedMap.prototype);
