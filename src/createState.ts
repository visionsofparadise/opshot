import { proxy, ref, snapshot, subscribe as valtioSubscribe, type Snapshot } from "valtio/vanilla";
import type { Meta } from "./createMeta";
import { getCyclicPath } from "./ops/cloneValue";
import { diffSnapshots } from "./ops/diff";
import type { Op } from "./ops/operation";
import { formatOperationPath } from "./ops/path";
import { assertSafeDataPaths, installBoundary, registerTrackedRoot } from "./valtio/boundary";

installBoundary();

export type Emission<Out extends object = {}> = { readonly isSideEffect: false; readonly meta: Out } | { readonly isSideEffect: true };

export type Mutate<T extends object, In extends object = {}> = (callback: (mutable: T) => void, ...meta: {} extends In ? [meta?: In] : [meta: In]) => void;
export type StateListener<T extends object, In extends object = {}, Out extends object = {}> = (state: State<T, In, Out>, ops: Array<Op>, emission: Emission<Out>) => void;

export interface OpshotHandle<T extends object, In extends object = {}, Out extends object = {}> {
	readonly unsafeMutable: object;
	readonly isMutating: boolean;
	readonly subscribe: (listener: StateListener<T, In, Out>) => () => void;
	readonly unwrap: () => Snapshot<T>;
}

export type State<T extends object, In extends object = {}, Out extends object = {}> = Snapshot<T> & {
	readonly mutate: Mutate<T, In>;
	readonly op: OpshotHandle<T, In, Out>;
};

export type Initializer<T extends object, In extends object = {}, Out extends object = {}> = (mutate: Mutate<T, In>, get: () => State<T, In, Out>) => T;
export type InitialProperties<T extends object> = T;

export const stateBrand: unique symbol = Symbol.for("opshot.state");

const requireObjectSnapshot = (value: unknown): object => {
	if (value !== null && (typeof value === "object" || typeof value === "function")) return value;

	throw new Error("opshot: state snapshots must have an object root");
};

interface MutableOpshotHandle<T extends object, In extends object, Out extends object> {
	unsafeMutable: object;
	isMutating: boolean;
	readonly subscribe: (listener: StateListener<T, In, Out>) => () => void;
	readonly unwrap: () => Snapshot<T>;
	readonly [stateBrand]: true;
}

export const augmentSideEffectCycleError = (error: unknown): Error | undefined => {
	const path = getCyclicPath(error);

	if (path === undefined) return undefined;

	return new Error(
		`opshot: a side-effect write created a cyclic value at ${formatOperationPath(path)}. Cycles cannot be tracked. This surfaced asynchronously because the write bypassed mutate (an unsafeMutable write, or a shared/entangled state). Use ignore() for back-linked structures, or ids.`,
	);
};

export function createState<T extends object, In extends object = {}, Out extends object = {}>(
	initializer: Initializer<T, In, Out> | InitialProperties<T>,
	meta?: Meta<In, Out>,
): State<T, In, Out> {
	return createGroupState(initializer, undefined, meta);
}

export function createGroupState<T extends object, In extends object = {}, Out extends object = {}>(
	initializer: Initializer<T, In, Out> | InitialProperties<T>,
	groupListeners?: Set<StateListener<object, In, Out>>,
	metaToken?: Meta<In, Out>,
): State<T, In, Out> {
	const callback: Initializer<T, In, Out> = typeof initializer === "function" ? initializer : () => initializer;

	const listeners = new Set<StateListener<T, In, Out>>();
	const created: { proxied?: T } = {};

	let lastReported: Snapshot<T> | undefined;
	let disarmWatchdog: (() => void) | undefined;

	const requireProxy = (): T => {
		const { proxied } = created;

		if (!proxied) throw new Error("opshot: called during createState definition");

		return proxied;
	};

	const armWatchdog = (proxied: T): void => {
		lastReported = snapshot(proxied);

		// valtio delivers empty op payloads without unstable_enableOp, so the watchdog diffs snapshots itself.
		disarmWatchdog = valtioSubscribe(proxied, () => {
			const current = snapshot(proxied);

			if (listeners.size === 0 && (groupListeners?.size ?? 0) === 0) {
				lastReported = current;

				return;
			}

			try {
				if (current === lastReported) return;

				const previous = lastReported;

				lastReported = current;

				const ops = diffSnapshots(requireObjectSnapshot(previous), requireObjectSnapshot(current));

				if (ops.length === 0) return;

				const emission: Emission<Out> = { isSideEffect: true };

				for (const listener of [...(groupListeners ?? [])]) listener(current as State<T, In, Out>, ops, emission);
				for (const listener of [...listeners]) listener(current as State<T, In, Out>, ops, emission);
			} catch (error) {
				throw augmentSideEffectCycleError(error) ?? error;
			}
		});
	};

	const get = (): State<T, In, Out> => snapshot(requireProxy()) as State<T, In, Out>;

	const mutate: Mutate<T, In> = (callback, ...metaArgs) => {
		const [meta] = metaArgs;
		const proxied = requireProxy();

		if (handle.isMutating) throw new Error("opshot: nested mutate on the same state");

		handle.isMutating = true;

		const before = snapshot(proxied);

		try {
			callback(proxied);
		} finally {
			handle.isMutating = false;
		}

		const after = snapshot(proxied);

		lastReported = after;

		if (before === after) return;

		if (listeners.size === 0 && (groupListeners?.size ?? 0) === 0) return;

		const ops = diffSnapshots(requireObjectSnapshot(before), requireObjectSnapshot(after));

		if (ops.length === 0) return;

		const emittedMeta = (metaToken?.defaults !== undefined ? { ...metaToken.defaults, ...meta } : (meta ?? {})) as Out;
		const emission: Emission<Out> = { isSideEffect: false, meta: emittedMeta };

		for (const listener of [...(groupListeners ?? [])]) listener(after as State<T, In, Out>, ops, emission);
		for (const listener of [...listeners]) listener(after as State<T, In, Out>, ops, emission);
	};

	const subscribe = (listener: StateListener<T, In, Out>): (() => void) => {
		if (groupListeners === undefined && listeners.size === 0) armWatchdog(requireProxy());

		listeners.add(listener);

		return () => {
			if (!listeners.delete(listener)) return;

			if (groupListeners === undefined && listeners.size === 0 && disarmWatchdog) {
				disarmWatchdog();
				disarmWatchdog = undefined;
			}
		};
	};

	const unwrap = (): Snapshot<T> => get();

	const literal = callback(mutate, get);

	assertSafeDataPaths(literal);

	for (const key of ["op", "mutate"] as const) {
		if (Object.hasOwn(literal, key)) throw new Error(`opshot: "${key}" is a reserved key on a state`);
	}

	const base = Object.create(Reflect.getPrototypeOf(literal)) as T;

	Object.defineProperties(base, Object.getOwnPropertyDescriptors(literal));

	const handle: MutableOpshotHandle<T, In, Out> = { unsafeMutable: base, isMutating: false, subscribe, unwrap, [stateBrand]: true };

	Object.defineProperty(base, "op", { value: ref(handle), enumerable: false, writable: false, configurable: false });
	Object.defineProperty(base, "mutate", { value: mutate, enumerable: false, writable: false, configurable: false });

	created.proxied = proxy(base);
	registerTrackedRoot(base);
	handle.unsafeMutable = created.proxied;

	if (groupListeners !== undefined) armWatchdog(created.proxied);

	return get();
}
