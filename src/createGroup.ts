import { createMutableState } from "./createMutableState";
import type { GroupListeners } from "./emit/emitterRegistry";
import type { StateSettings } from "./settings";

export interface Group {
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
