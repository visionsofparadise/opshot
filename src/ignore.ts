import { storageIdentityOf } from "./identity";

const ignored = new WeakSet<object>();

/**
 * Marks an object so every edge to it is untracked in every state.
 *
 * @typeParam T - Value type.
 * @param value - Value to mark or unmark.
 * @param on - Whether the mark is set.
 * @returns `value`.
 */
export function ignore<T>(value: T, on = true): T {
	if (value === null || (typeof value !== "object" && typeof value !== "function")) return value;

	if (on) ignored.add(storageIdentityOf(value));
	else ignored.delete(storageIdentityOf(value));

	return value;
}

export const isIgnored = (value: object): boolean => ignored.has(storageIdentityOf(value));
