import { useState } from "react";
import { isMeta, type Meta } from "../createMeta";
import type { Group } from "../createGroup";
import { createGroupState, type InitialProperties, type Initializer, type State } from "../createState";
import { useRetrackAll } from "./tracking";

/**
 * Creates tracked state for a component.
 *
 * @typeParam T - State shape.
 * @param initializer - Initial fields, or a function that returns them.
 * @param groupOrMeta - Optional group or meta token.
 * @returns The state.
 */
export function useTrackedState<T extends object, In extends object = {}, Out extends object = {}>(
	initializer: Initializer<T, In, Out> | InitialProperties<T>,
	groupOrMeta?: Group<In, Out> | Meta<In, Out>,
): State<T, In, Out> {
	const created = useState(() => {
		if (groupOrMeta !== undefined && !isMeta(groupOrMeta)) return (groupOrMeta as Group<In, Out>).createState(initializer);

		return createGroupState(initializer, undefined, groupOrMeta as Meta<In, Out> | undefined);
	})[0];
	const [fresh] = useRetrackAll([created]);

	return fresh as State<T, In, Out>;
}
