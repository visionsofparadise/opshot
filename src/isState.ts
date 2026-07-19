import { stateBrand, type State } from "./createState";
import { hasOwn } from "./utils/hasOwn";

export function isState(value: unknown): value is State<object> {
	if (typeof value !== "object" || value === null || !hasOwn(value, "op")) return false;

	const handle = value.op;

	if (typeof handle !== "object" || handle === null || !hasOwn(handle, stateBrand)) return false;

	return handle[stateBrand] === true;
}
