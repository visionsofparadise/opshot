import { brandTrackedPrototype, getAttachments, notifyAttachments, trackedBrand } from "./trackedWrapper";

// Reads, iteration, size, and instanceof all come from the real Map; only the mutating methods are
// overridden to build command-derived do/undo pairs around super. A string key addresses a per-key
// pair at its own pointer segment; a non-string key has no pointer representation, so its command
// emits a whole-representation entries-array pair. Unattached mutations skip pair-building entirely.
export class TrackedMap<K, V> extends Map<K, V> {
	declare readonly [trackedBrand]: true;

	override set(key: K, value: V): this {
		const notifiers = getAttachments(this);

		if (!notifiers) return super.set(key, value);

		const had = this.has(key);

		if (had && Object.is(this.get(key), value)) return super.set(key, value);

		if (typeof key === "string") {
			const prior = this.get(key);

			super.set(key, value);

			notifyAttachments(notifiers, {
				path: [key],
				payload: had ? { do: { op: "replace", value }, undo: { op: "replace", value: prior } } : { do: { op: "add", value }, undo: { op: "remove" } },
			});

			return this;
		}

		const before = [...this.entries()];

		super.set(key, value);

		notifyAttachments(notifiers, { path: [], payload: { do: { op: "replace", value: [...this.entries()] }, undo: { op: "replace", value: before } } });

		return this;
	}

	override delete(key: K): boolean {
		const notifiers = getAttachments(this);

		if (!notifiers || !this.has(key)) return super.delete(key);

		if (typeof key === "string") {
			const prior = this.get(key);
			const deleted = super.delete(key);

			notifyAttachments(notifiers, { path: [key], payload: { do: { op: "remove" }, undo: { op: "add", value: prior } } });

			return deleted;
		}

		const before = [...this.entries()];
		const deleted = super.delete(key);

		notifyAttachments(notifiers, { path: [], payload: { do: { op: "replace", value: [...this.entries()] }, undo: { op: "replace", value: before } } });

		return deleted;
	}

	override clear(): void {
		const notifiers = getAttachments(this);

		if (!notifiers || this.size === 0) {
			super.clear();

			return;
		}

		const before = [...this.entries()];

		super.clear();

		notifyAttachments(notifiers, { path: [], payload: { do: { op: "replace", value: [] }, undo: { op: "replace", value: before } } });
	}
}

brandTrackedPrototype(TrackedMap.prototype);
