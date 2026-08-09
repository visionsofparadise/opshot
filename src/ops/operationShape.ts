import type { Mutation, Operation } from "./operation";

export const shapeHalf = (
	half: Mutation,
): { verb: Mutation["verb"]; path: ReadonlyArray<string | number>; value?: unknown } =>
	"value" in half ? { verb: half.verb, path: half.path, value: half.value } : { verb: half.verb, path: half.path };

export const shapeOps = (
	ops: ReadonlyArray<Operation>,
): Array<{ do: ReturnType<typeof shapeHalf>; undo: ReturnType<typeof shapeHalf> }> =>
	ops.map((pair) => ({ do: shapeHalf(pair.do), undo: shapeHalf(pair.undo) }));
