const readProxyTargets = new WeakMap<object, object>();

export const registerReadProxyTarget = (readProxy: object, target: object): void => {
	readProxyTargets.set(readProxy, target);
};

export const getRegisteredReadProxyTarget = (readProxy: object): object | undefined => readProxyTargets.get(readProxy);
