const stateRoots = new WeakSet<object>();

export const markStateRoot = (target: object): void => {
	stateRoots.add(target);
};

export const isStateRoot = (target: object): boolean => stateRoots.has(target);
