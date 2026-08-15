export const pendingUnsafe = new WeakSet<object>();

declare const unsafeTrackedBrand: unique symbol;

/**
 * A value wrapped with `unsafeTrack`.
 *
 * @typeParam T - Value type.
 */
export type UnsafeTracked<T extends object> = T & { readonly [unsafeTrackedBrand]: true };

/**
 * Tracks a value that would otherwise be rejected.
 *
 * @typeParam T - Value type.
 * @param value - Value to track.
 * @returns The same value.
 */
export function unsafeTrack<T extends object>(value: T): UnsafeTracked<T> {
	pendingUnsafe.add(value);

	return value as UnsafeTracked<T>;
}
