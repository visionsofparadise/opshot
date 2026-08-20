import { snapshot } from "valtio/vanilla";
import { markDirtyPath } from "../occupancy";
import { diffObjects } from "../ops/diff";
import { isObjectLike } from "../ops/predicates";
import type { DirtyIndex, Handle } from "../handle";
import type { OperationPath } from "../ops/path";

const parentLiveOf = (root: object, path: OperationPath): object | undefined => {
	if (path.length === 0) return undefined;

	let current: unknown = root;

	for (const segment of path.slice(0, -1)) {
		if (!isObjectLike(current)) return undefined;

		current = Reflect.get(current, segment);
	}

	return isObjectLike(current) ? current : undefined;
};

export function dirtySinceSnapshot(handle: Handle, from: object): DirtyIndex {
	const dirty: DirtyIndex = { edges: new WeakMap(), nodes: new WeakSet() };

	for (const operation of diffObjects(from, snapshot(handle.proxy.root))) {
		const path = operation.do.path;

		markDirtyPath(dirty, handle, path, parentLiveOf(handle.proxy.root, path));
	}

	return dirty;
}
