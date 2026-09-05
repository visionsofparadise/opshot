import { recordOf, rawOf } from "./node";
import { peelReadProxy } from "./peelReadProxy";
import { isObjectLike } from "./utils/predicates";
import type { StateListeners } from "./emit/emitterRegistry";

export interface DirtyIndex {
	readonly edges: Map<object, Set<string>>;
	readonly nodes: Set<object>;
}

export interface PendingOperation {
	readonly node: object;
	readonly key: string;
	readonly meta: unknown;
	before?: unknown;
	after?: unknown;
	hasBefore: boolean;
	hasAfter: boolean;
}

export interface Handle {
	readonly root: object;
	readonly strict: boolean;
	readonly emitOn?: (flush: () => void) => void;
	readonly subscribers: StateListeners;
	readonly pending: Array<PendingOperation>;
	readonly pendingIndex: Map<object, Map<string, number>>;
	scheduledFlush?: () => void;
	lastDirty?: DirtyIndex;
}

export function handleOf(state: object): Handle | undefined {
	const peeled = peelReadProxy(state);

	if (!isObjectLike(peeled)) return undefined;

	const raw = rawOf(peeled);
	const record = recordOf(raw);

	if (record === undefined) return undefined;

	for (const handle of record.memberships.keys()) {
		if (handle.root === raw) return handle;
	}

	return undefined;
}

export function requireHandle(state: object, message: string): Handle {
	const handle = handleOf(state);

	if (handle === undefined) throw new Error(message);

	return handle;
}
