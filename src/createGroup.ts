import type { Meta } from "./createMeta";
import { createGroupState, type InitialProperties, type Initializer, type State, type StateListener } from "./createState";

/**
 * Creates states and receives their changes on one stream.
 *
 * @example
 * const group = createGroup()
 * const doc = group.createState({ title: "" })
 * group.subscribe((state, ops, emission) => {})
 */
export interface Group<In extends object = {}, Out extends object = {}> {
	/**
	 * Creates a state in this group.
	 *
	 * @typeParam T - State shape.
	 * @param initializer - Initial fields, or a function that returns them.
	 * @returns The state.
	 */
	createState<T extends object>(initializer: Initializer<T, In, Out> | InitialProperties<T>): State<T, In, Out>;

	/**
	 * Hears every change from states this group created.
	 *
	 * @param listener - Listener for those changes.
	 * @returns An unsubscribe function.
	 */
	subscribe(listener: StateListener<object, In, Out>): () => void;
}

/**
 * Creates a group.
 *
 * @param meta - Optional meta token shared by states this group creates.
 * @returns A new group.
 */
export function createGroup<In extends object = {}, Out extends object = {}>(meta?: Meta<In, Out>): Group<In, Out> {
	const listeners = new Set<StateListener<object, In, Out>>();

	return {
		createState<T extends object>(initializer: Initializer<T, In, Out> | InitialProperties<T>): State<T, In, Out> {
			return createGroupState(initializer, listeners, meta);
		},
		subscribe(listener: StateListener<object, In, Out>): () => void {
			listeners.add(listener);

			return () => {
				listeners.delete(listener);
			};
		},
	};
}
