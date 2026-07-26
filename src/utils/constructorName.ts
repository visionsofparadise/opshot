export const constructorName = (candidate: unknown): string =>
	typeof candidate === "function" && candidate.name !== "" ? candidate.name : "Object";
