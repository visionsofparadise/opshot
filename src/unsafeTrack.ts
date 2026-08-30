import { storageIdentityOf } from "./identity";

const unsafeMarked = new WeakSet<object>();

/**
 * Marks an object so a node entering a state while marked, or entering beneath an exempt node, is exempt from strict.
 *
 * @typeParam T - Value type.
 * @param value - Value to mark or unmark.
 * @param on - Whether the mark is set.
 * @returns `value`.
 */
export function unsafeTrack<T>(value: T, on = true): T {
	if (value === null || (typeof value !== "object" && typeof value !== "function")) return value;

	if (on) unsafeMarked.add(storageIdentityOf(value));
	else unsafeMarked.delete(storageIdentityOf(value));

	return value;
}

export const isUnsafeMarked = (value: object): boolean => unsafeMarked.has(storageIdentityOf(value));
