import { brandTrackedPrototype, getAttachments, notifyAttachments, trackedBrand } from "./trackedWrapper";

// Reads, iteration, size, and instanceof all come from the real Set; only the mutating methods are
// overridden to build command-derived do/undo pairs around super. Members have no pointer
// representation, so every command emits a whole-representation members-array pair. Unattached
// mutations skip pair-building entirely.
export class TrackedSet<T> extends Set<T> {
	declare readonly [trackedBrand]: true;

	override add(value: T): this {
		const notifiers = getAttachments(this);

		if (!notifiers || this.has(value)) return super.add(value);

		const before = [...this];

		super.add(value);

		notifyAttachments(notifiers, { path: [], payload: { do: { op: "replace", value: [...this] }, undo: { op: "replace", value: before } } });

		return this;
	}

	override delete(value: T): boolean {
		const notifiers = getAttachments(this);

		if (!notifiers || !this.has(value)) return super.delete(value);

		const before = [...this];
		const deleted = super.delete(value);

		notifyAttachments(notifiers, { path: [], payload: { do: { op: "replace", value: [...this] }, undo: { op: "replace", value: before } } });

		return deleted;
	}

	override clear(): void {
		const notifiers = getAttachments(this);

		if (!notifiers || this.size === 0) {
			super.clear();

			return;
		}

		const before = [...this];

		super.clear();

		notifyAttachments(notifiers, { path: [], payload: { do: { op: "replace", value: [] }, undo: { op: "replace", value: before } } });
	}
}

brandTrackedPrototype(TrackedSet.prototype);
