import { snapshot, type Snapshot } from "valtio/vanilla";
import type { State } from "./createState";

export function unwrap<T extends object>(state: State<T>): Snapshot<T> {
	const { op, ...rest } = snapshot(state.op.proxy) as State<T>;

	return rest as Snapshot<T>;
}
