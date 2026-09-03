export const assertMutableFacade = (facade: object, mutationKey: PropertyKey): void => {
	const descriptor = Reflect.getOwnPropertyDescriptor(facade, mutationKey);

	if (descriptor !== undefined && "writable" in descriptor && !descriptor.writable) {
		throw new Error("opshot: cannot mutate a non-writable tracked collection");
	}
};
