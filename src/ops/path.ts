/**
 * Path segments to a value in state.
 *
 * @example
 * ["document", "items", 0, "title"]
 */
export type OperationPath = ReadonlyArray<string | number>;

export const createOperationPath = (segments: ReadonlyArray<string | number>): OperationPath =>
	Array.isArray(segments) && Object.isFrozen(segments) ? segments : Object.freeze([...segments]);

export const appendOperationPath = (path: OperationPath, segment: string | number): OperationPath =>
	Object.freeze([...path, segment]);

const formatSegment = (segment: string | number): string => String(segment);

export const formatOperationPath = (path: OperationPath): string =>
	path.length === 0 ? "/" : `/${path.map(formatSegment).join("/")}`;
