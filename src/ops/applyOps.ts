// Default import, not `{ applyPatch }`: fast-json-patch declares no package `exports`, so Node's ESM loader resolves the bare specifier to its CommonJS `main`, where a named import throws "does not provide an export named 'applyPatch'".
import fastJsonPatch from "fast-json-patch";

import type { State } from "../createState";
import { TrackedDate } from "../tracked/trackedDate";
import { TrackedMap } from "../tracked/trackedMap";
import { TrackedSet } from "../tracked/trackedSet";
import { isOperation, type Operation } from "./operation";
import { parsePointer } from "./pointer";

type PlainOperation = Extract<Operation, { op: "add" | "replace" | "remove" }>;
type WrapperVariantOperation = Exclude<Operation, PlainOperation>;

const isPlainOperation = (operation: Operation): operation is PlainOperation => operation.op === "add" || operation.op === "replace" || operation.op === "remove";

const assertApplicable = (operation: unknown): void => {
	if (typeof operation === "object" && operation !== null && "isPatch" in operation) {
		throw new Error(
			"opshot: applyOps applies operation halves; pass op.do or op.undo. A marker (isPatch: false) is a notification and cannot be applied; project the value's state into plain fields instead.",
		);
	}

	if (!isOperation(operation)) {
		throw new Error("opshot: this op is a copy (spread, JSON, or structuredClone) and has lost its value. Apply the op objects the listener delivered; never copy them.");
	}
};

const unresolvedError = (pointer: string): Error => new Error(`opshot: ${pointer} does not resolve to a Tracked<Map|Set|Date>`);

const resolveTarget = (root: object, pointer: string): unknown => {
	let target: unknown = root;

	for (const segment of parsePointer(pointer)) {
		if (typeof target !== "object" || target === null) return undefined;

		target = Reflect.get(target, segment);
	}

	return target;
};

const applyWrapperOperation = (root: object, operation: WrapperVariantOperation): void => {
	const target = resolveTarget(root, operation.path);

	switch (operation.op) {
		case "mapSet": {
			if (!(target instanceof TrackedMap)) throw unresolvedError(operation.path);

			target.set(operation.key, operation.value);

			return;
		}

		case "mapDelete": {
			if (!(target instanceof TrackedMap)) throw unresolvedError(operation.path);

			target.delete(operation.key);

			return;
		}

		case "mapEntries": {
			if (!(target instanceof TrackedMap)) throw unresolvedError(operation.path);

			target.clear();

			for (const [key, value] of operation.entries) target.set(key, value);

			return;
		}

		case "setAdd": {
			if (!(target instanceof TrackedSet)) throw unresolvedError(operation.path);

			target.add(operation.member);

			return;
		}

		case "setDelete": {
			if (!(target instanceof TrackedSet)) throw unresolvedError(operation.path);

			target.delete(operation.member);

			return;
		}

		case "setEntries": {
			if (!(target instanceof TrackedSet)) throw unresolvedError(operation.path);

			target.clear();

			for (const member of operation.members) target.add(member);

			return;
		}

		case "dateSet": {
			if (!(target instanceof TrackedDate)) throw unresolvedError(operation.path);

			target.setTime(operation.epoch);

			return;
		}
	}
};

export function applyOps<T extends object, In extends object = {}, Out extends object = {}>(
	state: State<T, In, Out>,
	operations: ReadonlyArray<Operation>,
	...meta: {} extends In ? [meta?: In] : [meta: In]
): void {
	for (const operation of operations) assertApplicable(operation);

	state.mutate((mutable) => {
		let batch: Array<PlainOperation> = [];

		const flushBatch = (): void => {
			if (batch.length === 0) return;

			fastJsonPatch.applyPatch(mutable, batch);
			batch = [];
		};

		for (const operation of operations) {
			if (isPlainOperation(operation)) {
				batch.push(operation);

				continue;
			}

			flushBatch();
			applyWrapperOperation(mutable, operation);
		}

		flushBatch();
	}, ...meta);
}
