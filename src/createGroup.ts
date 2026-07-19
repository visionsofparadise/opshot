import type { Meta } from "./createMeta";
import { createGroupState, type InitialProperties, type Initializer, type State, type StateListener } from "./createState";

export interface Group<In extends object = {}, Out extends object = {}> {
	createState<T extends object>(initializer: Initializer<T, In, Out> | InitialProperties<T>): State<T, In, Out>;
	subscribe(listener: StateListener<object, In, Out>): () => void;
}

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
