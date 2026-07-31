/**
 * Path segments to a value in state.
 *
 * @example
 * ["document", "items", 0, "title"]
 */
export type OperationPath = ReadonlyArray<string | number>;

export const createOperationPath = (segments: ReadonlyArray<string | number>): OperationPath =>
	Object.freeze([...segments]);

export const appendOperationPath = (path: OperationPath, segment: string | number): OperationPath =>
	Object.freeze([...path, segment]);

const escapeSegment = (segment: string): string => segment.replaceAll("~", "~0").replaceAll("/", "~1");

const formatSegment = (segment: string | number): string =>
	typeof segment === "string" ? escapeSegment(segment) : String(segment);

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
