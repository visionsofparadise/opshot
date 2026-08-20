import { createMutableState, type Unmarked } from "./createMutableState";
import type { GroupListeners } from "./emit/emitterRegistry";
import type { MutableNodeOptions } from "./settings";

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
	createMutableState<T extends object>(properties: T, options?: MutableNodeOptions): Unmarked<T>;
}

class UnknownGroupError extends Error {
	constructor() {
		super("opshot: unknown group");
		this.name = "UnknownGroupError";
	}
}

const groupChainByGroup = new WeakMap<Group, ReadonlyArray<GroupListeners>>();

export function isGroup(value: unknown): value is Group {
	return typeof value === "object" && value !== null && groupChainByGroup.has(value as Group);
}

export function getGroupListeners(group: Group): GroupListeners {
	const chain = groupChainByGroup.get(group);
	const listeners = chain?.at(-1);

	if (listeners === undefined) throw new UnknownGroupError();

	return listeners;
}

export function getGroupChain(group: Group): ReadonlyArray<GroupListeners> {
	const chain = groupChainByGroup.get(group);

	if (chain === undefined) throw new UnknownGroupError();

	return chain;
}

/**
 * Creates a group.
 *
 * @param parent - Optional parent group whose listeners hear this group's states.
 * @returns A new group.
 */
export function createGroup(parent?: Group): Group {
	if (parent !== undefined && !isGroup(parent)) {
		throw new Error("opshot: parent is not a group");
	}

	const listeners: GroupListeners = new Map();
	const group: Group = {
		createMutableState<T extends object>(properties: T, options?: MutableNodeOptions): Unmarked<T> {
			return createMutableState(properties, { ...options, group });
		},
	};

	const chain: ReadonlyArray<GroupListeners> =
		parent === undefined ? [listeners] : [...getGroupChain(parent), listeners];

	groupChainByGroup.set(group, chain);

	return group;
}
