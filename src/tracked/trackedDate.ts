import { brandTrackedPrototype, getAttachments, notifyAttachments, trackedBrand } from "./trackedWrapper";

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

			notifyAttachments(notifiers, { path: [], payload: { do: { kind: "dateSet", epoch: after }, undo: { kind: "dateSet", epoch: before } } });

			return result;
		},
		writable: true,
		enumerable: false,
		configurable: true,
	});
}
