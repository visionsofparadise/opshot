import { ref } from "valtio/vanilla";

declare const ignoredMarker: unique symbol;

/**
 * A value wrapped with `ignore`.
 *
 * @typeParam T - Value type.
 */
export type Ignored<T extends object> = T & { readonly [ignoredMarker]: true };

/**
 * Marks a value as an **endpoint**: the graph ends here. The value is kept out of reactivity and
 * ops; beyond it the model is silent. Declarations are route-scoped — a child of this leaf later
 * admitted through a separate tracked edge tracks on that edge while the beyond-endpoint route
 * stays unpromised.
 *
 * @typeParam T - Value type.
 * @param value - Value to ignore.
 * @returns The same value.
 */
export const ignore = ref as <T extends object>(value: T) => Ignored<T>;
