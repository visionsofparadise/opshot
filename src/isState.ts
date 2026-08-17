import { stateBrand, type State } from "./createState";
import { hasOwn } from "./utils/hasOwn";

/**
 * Returns whether a value is an opshot state.
 *
 * @param value - Value to test.
 * @returns True if it is a state.
 */
export function isState(value: unknown): value is State<object> {
	if (typeof value !== "object" || value === null || !hasOwn(value, "op")) return false;

	const handle = value.op;

	if (typeof handle !== "object" || handle === null || !hasOwn(handle, stateBrand)) return false;

	return handle[stateBrand] === true;
}
