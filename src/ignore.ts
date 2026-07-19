import { ref } from "valtio/vanilla";

export const ignore: typeof ref = ref;

// The type of an ignored field. ignore() carries valtio's snapshot-ignore marker so the value's
// interior stays writable through the readonly Snapshot; naming a field plain T in an explicit
// interface erases that marker and the interior reads back readonly. Use this for the field type.
export type Ignored<T extends object> = ReturnType<typeof ignore<T>>;
