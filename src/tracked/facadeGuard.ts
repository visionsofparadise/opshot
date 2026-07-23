import { getUntracked } from "proxy-compare";

import { getRegisteredTarget } from "../identity";
import { installBoundary } from "../valtio/boundary";

installBoundary();

export const assertMutableFacade = (facade: object, mutationKey: PropertyKey): void => {
	const facadeSource = getUntracked(facade);
	const isRegisteredCopy =
		getRegisteredTarget(facade) !== undefined || (facadeSource !== null && getRegisteredTarget(facadeSource) !== undefined);
	const descriptor = Reflect.getOwnPropertyDescriptor(facade, mutationKey);

	if (isRegisteredCopy || (descriptor !== undefined && "writable" in descriptor && !descriptor.writable)) {
		throw new Error("opshot: cannot mutate a tracked collection snapshot");
	}
};
