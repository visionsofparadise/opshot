import { flushWindow } from "./emit/window";
import { requireHandle } from "./handle";

/**
 * Ends the state's window now, delivering the operations gathered so far.
 *
 * @param state - State to flush.
 */
export function flush(state: object): void {
	flushWindow(requireHandle(state, "opshot: flush requires a state"));
}
