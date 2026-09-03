export const isObjectLike = (value: unknown): value is object =>
	value !== null && (typeof value === "object" || typeof value === "function");

export const isCanonicalArrayIndexString = (key: string): boolean => {
	const index = Number(key);

	return Number.isInteger(index) && index >= 0 && index < 4_294_967_295 && String(index) === key;
};
