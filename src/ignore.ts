export const ignoreMarker: unique symbol = Symbol("opshot.ignore");

/**
 * A factory-argument marker wrapping `T`.
 *
 * @typeParam T - Value type.
 */
export interface Ignored<T> {
	readonly [ignoreMarker]: T;
}

/**
 * Marks a factory-argument value so the edge at that path is untracked in that state.
 *
 * @typeParam T - Value type.
 * @param value - Value to ignore.
 * @returns A marker consumed at create.
 */
export function ignore<T>(value: T): Ignored<T> {
	return { [ignoreMarker]: value };
}
