import { ref } from "valtio/vanilla";

export const ignore: typeof ref = ref;

export type Ignored<T extends object> = ReturnType<typeof ignore<T>>;
