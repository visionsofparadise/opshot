import { createGroupState, type Define, type State, type StateListener } from "./createState";

export interface Group {
	createState<T extends object>(define: Define<T>): State<T>;
	subscribe(listener: StateListener<object>): () => void;
}

export function createGroup(): Group {
	const listeners = new Set<StateListener<object>>();

	return {
		createState<T extends object>(define: Define<T>): State<T> {
			return createGroupState(define, listeners);
		},
		subscribe(listener: StateListener<object>): () => void {
			listeners.add(listener);

			return () => {
				listeners.delete(listener);
			};
		},
	};
}
