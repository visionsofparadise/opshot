import { useState } from "react";
import { createGroup, type Group } from "../createGroup";

/**
 * Creates a group for a component.
 *
 * @returns The group.
 */
export function useGroup(): Group {
	return useState(() => createGroup())[0];
}
