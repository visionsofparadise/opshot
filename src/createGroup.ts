import { createGroupState, type Define, type Meta, type MetaRecord, type State, type StateListener } from "./createState";

export interface Group<In extends object = MetaRecord, Out extends object = MetaRecord> {
	createState<T extends object>(define: Define<T, In, Out>): State<T, In, Out>;
	subscribe(listener: StateListener<object, In, Out>): () => void;
}

export function createGroup(): Group;
export function createGroup<In extends object, Out extends object>(meta: Meta<In, Out>): Group<In, Out>;
export function createGroup<In extends object, Out extends object>(meta?: Meta<In, Out>): Group<In, Out> {
	const listeners = new Set<StateListener<object, In, Out>>();

	return {
		createState<T extends object>(define: Define<T, In, Out>): State<T, In, Out> {
			return createGroupState(define, listeners, meta);
		},
		subscribe(listener: StateListener<object, In, Out>): () => void {
			listeners.add(listener);

			return () => {
				listeners.delete(listener);
			};
		},
	};
}
