import { ref } from "valtio/vanilla";

export const ignore: typeof ref = ref;

// ignore() carries valtio's snapshot-ignore marker so the interior stays writable; naming a field plain T erases it.
export type Ignored<T extends object> = ReturnType<typeof ignore<T>>;
