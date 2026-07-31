import { ref } from "valtio/vanilla";

declare const ignoredMarker: unique symbol;

/**
 * A value wrapped with `ignore`.
 *
 * @typeParam T - Value type.
 */
export type Ignored<T extends object> = T & { readonly [ignoredMarker]: true };

/**
 * Keeps a value out of reactivity and ops.
 *
 * @typeParam T - Value type.
 * @param value - Value to ignore.
 * @returns The same value.
 */
export const ignore = ref as <T extends object>(value: T) => Ignored<T>;
