import { useState } from "react";
import type { Meta } from "../createMeta";
import { createGroup, type Group } from "../createGroup";

/**
 * Creates a group for a component.
 *
 * @param meta - Optional meta token.
 * @returns The group.
 */
export function useGroup<In extends object = {}, Out extends object = {}>(meta?: Meta<In, Out>): Group<In, Out> {
	return useState<Group<In, Out>>(() => (meta === undefined ? createGroup() : createGroup(meta)))[0];
}
