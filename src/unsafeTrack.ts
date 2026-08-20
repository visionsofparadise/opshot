export const unsafeMarker: unique symbol = Symbol("opshot.unsafe");

/**
 * A factory-argument marker wrapping `T`.
 *
 * @typeParam T - Value type.
 */
export interface UnsafeTracked<T> {
	readonly [unsafeMarker]: T;
}

/**
 * Marks a factory-argument value so strict is disabled at and under that path.
 *
 * @typeParam T - Value type.
 * @param value - Value to track without strict.
 * @returns A marker consumed at create.
 */
export function unsafeTrack<T>(value: T): UnsafeTracked<T> {
	return { [unsafeMarker]: value };
}
