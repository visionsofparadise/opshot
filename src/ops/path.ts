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

export const operationPathsEqual = (left: OperationPath, right: OperationPath): boolean => {
	if (left.length !== right.length) return false;

	for (let index = 0; index < left.length; index++) {
		if (left[index] !== right[index]) return false;
	}

	return true;
};
