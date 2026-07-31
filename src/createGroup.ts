import { createMutableState } from "./createMutableState";
import type { GroupListeners } from "./emit/emitterRegistry";
import type { StateSettings } from "./settings";

/**
 * Creates states and receives their changes on one stream.
 *
 * @example
 * const group = createGroup()
 * const doc = group.createMutableState({ title: "" })
 * subscribe(group, (state, ops, meta) => {})
 */
export interface Group {
	/**
	 * Creates a state in this group.
	 *
	 * @typeParam T - State shape.
	 * @param properties - Initial fields.
	 * @param options - Creation options.
	 * @returns The state.
	 */
	createMutableState<T extends object>(properties: T, options?: StateSettings): T;
}

const groupListenersByGroup = new WeakMap<Group, GroupListeners>();

export function isGroup(value: unknown): value is Group {
	return typeof value === "object" && value !== null && groupListenersByGroup.has(value as Group);
}

export function getGroupListeners(group: Group): GroupListeners {
	const listeners = groupListenersByGroup.get(group);

	if (listeners === undefined) throw new Error("opshot: unknown group");

	return listeners;
}

/**
 * Creates a group.
 *
 * @returns A new group.
 */
export function createGroup(): Group {
	const listeners: GroupListeners = new Map();
	const group: Group = {
		createMutableState<T extends object>(properties: T, options?: StateSettings): T {
			return createMutableState(properties, { ...options, group });
		},
	};

	groupListenersByGroup.set(group, listeners);

	return group;
}
