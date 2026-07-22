const unsafeTrackedSet = new WeakSet();

declare const unsafeTrackedBrand: unique symbol;

export type UnsafeTracked<T extends object> = T & { readonly [unsafeTrackedBrand]: true };

export function unsafeTrack<T extends object>(value: T): UnsafeTracked<T> {
	unsafeTrackedSet.add(value);

	return value as UnsafeTracked<T>;
}

export function isUnsafeTracked(value: unknown): boolean {
	return typeof value === "object" && value !== null && unsafeTrackedSet.has(value);
}
