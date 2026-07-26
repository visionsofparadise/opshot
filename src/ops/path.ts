export type OperationPath = ReadonlyArray<unknown>;

export const createOperationPath = (segments: ReadonlyArray<unknown>): OperationPath => Object.freeze([...segments]);

export const appendOperationPath = (path: OperationPath, segment: unknown): OperationPath =>
	Object.freeze([...path, segment]);

const escapeSegment = (segment: string): string => segment.replaceAll("~", "~0").replaceAll("/", "~1");

const formatSegment = (segment: unknown): string => {
	if (typeof segment === "symbol") return "<symbol>";

	if ((typeof segment === "object" && segment !== null) || typeof segment === "function") return "<identity>";

	if (typeof segment === "string") return escapeSegment(segment);

	if (typeof segment === "number" || typeof segment === "bigint" || typeof segment === "boolean")
		return String(segment);

	if (segment === null) return "null";

	return "undefined";
};

export const formatOperationPath = (path: OperationPath): string =>
	path.length === 0 ? "" : `/${path.map(formatSegment).join("/")}`;

export const assertSafePath = (path: OperationPath): void => {
	for (let index = 0; index < path.length; index++) {
		const segment = path[index];

		if (segment === "__proto__" || (segment === "prototype" && path[index - 1] === "constructor")) {
			throw new Error(`opshot: reserved operation path ${formatOperationPath(path)}`);
		}
	}
};
