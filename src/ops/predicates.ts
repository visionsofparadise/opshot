export const MAX_ARRAY_LENGTH = 4_294_967_295;

export const isObjectLike = (value: unknown): value is object =>
	value !== null && (typeof value === "object" || typeof value === "function");

export const isCanonicalArrayIndex = (segment: unknown): segment is number =>
	Number.isInteger(segment) && typeof segment === "number" && segment >= 0 && segment < MAX_ARRAY_LENGTH;

export const isCanonicalArrayIndexString = (key: string): boolean => {
	const index = Number(key);

	return Number.isInteger(index) && index >= 0 && index < MAX_ARRAY_LENGTH && String(index) === key;
};
