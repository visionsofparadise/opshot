import { createMutableState } from "./createMutableState";
import type { GroupListener } from "./emitter";

export interface Group {
	createState<T extends object>(properties: T): T;
}

const groupListenersByGroup = new WeakMap<Group, Set<GroupListener>>();

export function isGroup(value: unknown): value is Group {
	return typeof value === "object" && value !== null && groupListenersByGroup.has(value as Group);
}

export function getGroupListeners(group: Group): Set<GroupListener> {
	const listeners = groupListenersByGroup.get(group);

	if (listeners === undefined) throw new Error("opshot: unknown group");

	return listeners;
}

export function createGroup(): Group {
	const listeners = new Set<GroupListener>();
	const group: Group = {
		createState<T extends object>(properties: T): T {
			return createMutableState(properties, group);
		},
	};

	groupListenersByGroup.set(group, listeners);

	return group;
}
