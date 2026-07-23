const wrapperTargets = new WeakMap<object, object>();

export const registerWrapperTarget = (wrapper: object, target: object): void => {
	wrapperTargets.set(wrapper, target);
};

export const getRegisteredWrapperTarget = (wrapper: object): object | undefined => wrapperTargets.get(wrapper);
