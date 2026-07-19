export const hasOwn = <K extends PropertyKey>(value: object, key: K): value is Record<K, unknown> => Object.hasOwn(value, key);
