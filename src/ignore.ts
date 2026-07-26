import { ref } from "valtio/vanilla";

declare const ignoredMarker: unique symbol;

export type Ignored<T extends object> = T & { readonly [ignoredMarker]: true };

export const ignore = ref as <T extends object>(value: T) => Ignored<T>;
