import { unstable_getInternalStates } from "valtio/vanilla";
import { peelReadProxy } from "./peelReadProxy";
import type { GroupListeners, StateListeners } from "./emit/emitterRegistry";
import type { OperationPath } from "./ops/path";
import type { EmissionScheduler } from "./settings";

const occupancies = new WeakMap<object, Set<WeakRef<Handle>>>();

const { proxyStateMap } = unstable_getInternalStates();

const rawTargetOf = (value: object): object => proxyStateMap.get(value)?.[0] ?? value;

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
	onError?: (error: unknown) => void;
	unsafeAt: ReadonlySet<string>;
	ignoredAt: ReadonlySet<string>;
	routes: Map<object, ReadonlyArray<OperationPath>>;
	lastDirty?: DirtyIndex;
	stamp: object;
	version: number;
	replaying: boolean;
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

const rawOf = (node: object): object => {
	const peeled = peelReadProxy(node);

	return rawTargetOf(typeof peeled === "object" && peeled !== null ? peeled : node);
};

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
