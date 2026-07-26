import { useState } from "react";
import { createGroup, type Group } from "../createGroup";

export function useGroup(): Group {
	return useState(() => createGroup())[0];
}
