import { unstable_getInternalStates } from "valtio/vanilla";
import type { GroupListeners, StateListeners } from "./emit/emitterRegistry";
import type { EmissionScheduler } from "./settings";

const occupancies = new WeakMap<object, Set<WeakRef<Handle>>>();

const { proxyStateMap } = unstable_getInternalStates();

const rawTargetOf = (value: object): object => proxyStateMap.get(value)?.[0] ?? value;

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
}

export function registerHandle(target: object, handle: Handle): void {
	let occupants = occupancies.get(target);

	if (occupants === undefined) {
		occupants = new Set();
		occupancies.set(target, occupants);
	}

	occupants.add(new WeakRef(handle));
}

export function handlesOf(node: object): Array<Handle> {
	const target = rawTargetOf(node);
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
	const target = rawTargetOf(node);

	for (const handle of handlesOf(node)) {
		if (rawTargetOf(handle.proxy.root) === target) return handle;
	}

	return undefined;
}

export function requireHandle(state: object, message: string): Handle {
	const value: unknown = state;

	if (typeof value !== "object" || value === null) throw new Error(message);

	const handle = handleOf(value);

	if (handle === undefined) throw new Error(message);

	return handle;
}
