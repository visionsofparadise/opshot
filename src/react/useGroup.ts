import { useState } from "react";
import { createGroup, type Group } from "../createGroup";

/**
 * Creates a group for a component.
 *
 * @param parent - Optional parent group whose listeners hear this group's states.
 * @returns The group.
 */
export function useGroup(parent?: Group): Group {
	return useState(() => createGroup(parent))[0];
}
