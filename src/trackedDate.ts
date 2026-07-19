import { brandTrackedPrototype, getAttachments, notifyAttachments, trackedBrand } from "./trackedWrapper";

// Reads and instanceof come from the real Date; every mutator is a set* method, enumerated from
// Date.prototype at module load so annex-B setYear is covered alongside the standard setters. Each
// override reads the prior epoch, applies through the built-in, and emits a scalar epoch replace
// pair -- the Date representation is its timestamp. Unattached mutations skip pair-building entirely.
export class TrackedDate extends Date {
	declare readonly [trackedBrand]: true;
}

brandTrackedPrototype(TrackedDate.prototype);

for (const name of Object.getOwnPropertyNames(Date.prototype)) {
	if (!name.startsWith("set")) continue;

	const method: unknown = Reflect.get(Date.prototype, name);

	if (typeof method !== "function") continue;

	Object.defineProperty(TrackedDate.prototype, name, {
		value: function (this: TrackedDate, ...args: Array<unknown>): unknown {
			const notifiers = getAttachments(this);

			if (!notifiers) {
				const skipped: unknown = Reflect.apply(method, this, args);

				return skipped;
			}

			const before = this.getTime();
			const result: unknown = Reflect.apply(method, this, args);
			const after = this.getTime();

			if (Object.is(before, after)) return result;

			notifyAttachments(notifiers, { path: [], payload: { do: { op: "replace", value: after }, undo: { op: "replace", value: before } } });

			return result;
		},
		writable: true,
		enumerable: false,
		configurable: true,
	});
}
