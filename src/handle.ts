import { rawOf, rawTargetOf } from "./valtio/rawTarget";
import type { BatchFrame } from "./batch";
import type { NodeRecord } from "./edges";
import type { GroupListeners, StateListeners } from "./emit/emitterRegistry";
import type { EmissionScheduler } from "./settings";

const occupancies = new WeakMap<object, Set<WeakRef<Handle>>>();

export interface DirtyIndex {
	readonly edges: WeakMap<object, Set<string | symbol>>;
	readonly nodes: WeakSet<object>;
}

export interface Handle {
	proxy: { readonly root: object };
	lastSnapshot: object;
	hasPendingWrites: boolean;
	isFlushScheduled: boolean;
	isFlushHeld: boolean;
	flushGeneration: number;
	subscribers: StateListeners;
	groups?: ReadonlyArray<GroupListeners>;
	disarmWatch?: () => void;
	emitOn?: EmissionScheduler;
	strict: boolean;
	nodes: WeakMap<object, NodeRecord>;
	byId: Map<number, object>;
	nextInternId: number;
	internedThrough: number;
	lastDirty?: DirtyIndex;
	stamp: object;
	version: number;
	replaying: boolean;
	pendingOwner: BatchFrame | undefined;
}

export function registerHandle(target: object, handle: Handle): void {
	let occupants = occupancies.get(target);

	if (occupants === undefined) {
		occupants = new Set();
		occupancies.set(target, occupants);
	}

	for (const reference of occupants) {
		if (reference.deref() === handle) return;
	}

	occupants.add(new WeakRef(handle));
}

export function handlesOf(node: object): Array<Handle> {
	const target = rawOf(node);
	const occupants = occupancies.get(target);

	if (occupants === undefined) return [];

	const handles = new Array<Handle>();

	for (const reference of occupants) {
		const handle = reference.deref();

		if (handle === undefined) {
			occupants.delete(reference);

			continue;
		}

		handles.push(handle);
	}

	return handles;
}

export function handleOf(node: object): Handle | undefined {
	const target = rawOf(node);

	for (const handle of handlesOf(node)) {
		if (rawTargetOf(handle.proxy.root) === target) return handle;
	}

	return undefined;
}

export function requireHandle(state: object, message: string): Handle {
	const handle = handleOf(state);

	if (handle === undefined) throw new Error(message);

	return handle;
}
