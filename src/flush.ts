import { flushWindow } from "./emit/window";
import { requireHandle } from "./handle";

/**
 * Ends each state's window now, delivering the operations gathered so far.
 *
 * @param state - State to flush.
 * @param states - Further states, flushed in order.
 */
export function flush(state: object, ...states: ReadonlyArray<object>): void {
	for (const target of [state, ...states]) flushWindow(requireHandle(target, "opshot: flush requires a state"));
}
