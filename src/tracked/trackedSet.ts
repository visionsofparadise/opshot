import { brandTrackedPrototype, getAttachments, notifyAttachments, trackedBrand } from "./trackedWrapper";

/**
 * Tracked `Set` for use in state.
 *
 * @typeParam T - Member type.
 */
export class TrackedSet<T> extends Set<T> {
	declare readonly [trackedBrand]: true;

	override add(value: T): this {
		const notifiers = getAttachments(this);

		if (!notifiers || this.has(value)) return super.add(value);

		super.add(value);

		notifyAttachments(notifiers, { path: [], payload: { do: { kind: "setAdd", member: value }, undo: { kind: "setDelete", member: value } } });

		return this;
	}

	override delete(value: T): boolean {
		const notifiers = getAttachments(this);

		if (!notifiers || !this.has(value)) return super.delete(value);

		const deleted = super.delete(value);

		notifyAttachments(notifiers, { path: [], payload: { do: { kind: "setDelete", member: value }, undo: { kind: "setAdd", member: value } } });

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

		notifyAttachments(notifiers, { path: [], payload: { do: { kind: "setEntries", members: [] }, undo: { kind: "setEntries", members: before } } });
	}
}

brandTrackedPrototype(TrackedSet.prototype);
