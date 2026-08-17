import { ref } from "valtio/vanilla";

/**
 * Keeps a value out of reactivity and ops.
 *
 * @param value - Value to ignore.
 * @returns The same value.
 */
export const ignore: typeof ref = ref;

// ignore() carries valtio's snapshot-ignore marker so the interior stays writable; naming a field plain T erases it.

/**
 * A value wrapped with `ignore`.
 *
 * @typeParam T - Value type.
 */
export type Ignored<T extends object> = ReturnType<typeof ignore<T>>;
