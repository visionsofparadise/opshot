const unsafeTrackedSet = new WeakSet();

declare const unsafeTrackedBrand: unique symbol;

/**
 * A value wrapped with `unsafeTrack`.
 *
 * @typeParam T - Value type.
 */
export type UnsafeTracked<T extends object> = T & { readonly [unsafeTrackedBrand]: true };

/**
 * Declares a value **tracked** that would otherwise be rejected (no determined treatment by shape).
 * The mark is a declaration on the edge that admits it; `strict: false` is the same admission for
 * every reject-lane value entering that graph. The mark travels with a detached value into a
 * strict graph; a live join of strict and non-strict graphs still throws.
 *
 * @typeParam T - Value type.
 * @param value - Value to track.
 * @returns The same value.
 */
export function unsafeTrack<T extends object>(value: T): UnsafeTracked<T> {
	unsafeTrackedSet.add(value);

	return value as UnsafeTracked<T>;
}

export function isUnsafeTracked(value: unknown): boolean {
	return typeof value === "object" && value !== null && unsafeTrackedSet.has(value);
}
