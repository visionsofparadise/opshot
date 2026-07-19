import { proxy, ref, snapshot, subscribe as valtioSubscribe, type Snapshot } from "valtio/vanilla";
import type { Meta } from "./createMeta";
import { getCyclicErrorPointer } from "./ops/cloneValue";
import { diffSnapshots } from "./ops/diff";
import type { Op } from "./ops/operation";
import { parseWrapperNotification, type WrapperPayload } from "./tracked/trackedWrapper";
import { hasOwn } from "./utils/hasOwn";
import { installBoundary } from "./valtio/boundary";

installBoundary();

export type Emission<Out extends object = {}> = { readonly isSideEffect: false; readonly meta: Out } | { readonly isSideEffect: true };

export type Mutate<T extends object, In extends object = {}> = (callback: (mutable: T) => void, ...meta: {} extends In ? [meta?: In] : [meta: In]) => void;
export type StateListener<T extends object, In extends object = {}, Out extends object = {}> = (state: State<T, In, Out>, ops: Array<Op>, emission: Emission<Out>) => void;

export interface OpshotHandle<T extends object, In extends object = {}, Out extends object = {}> {
	readonly unsafeMutable: object;
	readonly isMutating: boolean;
	readonly subscribe: (listener: StateListener<T, In, Out>) => () => void;
	readonly isSameState: (other: unknown) => boolean;
	readonly unwrap: () => Snapshot<T>;
}

export type State<T extends object, In extends object = {}, Out extends object = {}> = Snapshot<T> & {
	readonly mutate: Mutate<T, In>;
	readonly op: OpshotHandle<T, In, Out>;
};

export type Initializer<T extends object, In extends object = {}, Out extends object = {}> = (mutate: Mutate<T, In>, get: () => State<T, In, Out>) => T;
export type InitialProperties<T extends object> = T;

export const stateBrand: unique symbol = Symbol.for("opshot.state");

interface MutableOpshotHandle<T extends object, In extends object, Out extends object> {
	unsafeMutable: object;
	isMutating: boolean;
	readonly subscribe: (listener: StateListener<T, In, Out>) => () => void;
	readonly isSameState: (other: unknown) => boolean;
	readonly unwrap: () => Snapshot<T>;
	readonly [stateBrand]: true;
}

export const augmentSideEffectCycleError = (error: unknown): Error | undefined => {
	const pointer = getCyclicErrorPointer(error);

	if (pointer === undefined) return undefined;

	return new Error(
		`opshot: a side-effect write created a cyclic value at ${pointer}. Cycles cannot be tracked. This surfaced asynchronously because the write bypassed mutate (an unsafeMutable write, or a shared/entangled state). Use ignore() for back-linked structures, or ids.`,
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

	const consumedWrapperPayloads = new WeakSet<WrapperPayload>();

	let lastReported: Snapshot<T> | undefined;
	let disarmWatchdog: (() => void) | undefined;

	const requireProxy = (): T => {
		const { proxied } = created;

		if (!proxied) throw new Error("opshot: called during createState definition");

		return proxied;
	};

	const armWatchdog = (proxied: T): void => {
		lastReported = snapshot(proxied);

		// valtio delivers empty op payloads without unstable_enableOp, so the watchdog diffs snapshots itself; the ops carry only tracked-wrapper entries.
		disarmWatchdog = valtioSubscribe(proxied, (valtioOps) => {
			const current = snapshot(proxied);

			if (listeners.size === 0 && (groupListeners?.size ?? 0) === 0) {
				lastReported = current;

				return;
			}

			try {
				const ops: Array<Op> = [];

				if (current !== lastReported) {
					const previous = lastReported;

					lastReported = current;

					ops.push(...diffSnapshots(previous, current));
				}

				for (const entry of valtioOps) {
					const parsed = parseWrapperNotification(entry);

					if (!parsed || consumedWrapperPayloads.has(parsed.payload)) continue;

					ops.push(parsed.op);
				}

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
		const wrapperOps: Array<Op> = [];

		const detachCollector =
			listeners.size > 0 || (groupListeners?.size ?? 0) > 0
				? valtioSubscribe(
						proxied,
						(valtioOps) => {
							for (const entry of valtioOps) {
								const parsed = parseWrapperNotification(entry);

								if (!parsed) continue;

								consumedWrapperPayloads.add(parsed.payload);
								wrapperOps.push(parsed.op);
							}
						},
						true,
					)
				: undefined;

		try {
			callback(proxied);
		} finally {
			handle.isMutating = false;
			detachCollector?.();
		}

		const after = snapshot(proxied);

		lastReported = after;

		if (before === after) return;

		if (listeners.size === 0 && (groupListeners?.size ?? 0) === 0) return;

		const ops = [...diffSnapshots(before, after), ...wrapperOps];

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

	const isSameState = (other: unknown): boolean => typeof other === "object" && other !== null && hasOwn(other, "op") && other.op === handle;

	const unwrap = (): Snapshot<T> => {
		const { op, mutate, ...rest } = get();

		return rest as Snapshot<T>;
	};

	const literal = callback(mutate, get);

	for (const key of ["op", "mutate"] as const) {
		if (Object.hasOwn(literal, key)) throw new Error(`opshot: "${key}" is a reserved key on a state`);
	}

	const base = Object.create(Reflect.getPrototypeOf(literal)) as T;

	Object.defineProperties(base, Object.getOwnPropertyDescriptors(literal));

	const handle: MutableOpshotHandle<T, In, Out> = { unsafeMutable: base, isMutating: false, subscribe, isSameState, unwrap, [stateBrand]: true };

	Object.defineProperty(base, "op", { value: ref(handle), enumerable: true, writable: false, configurable: false });
	Object.defineProperty(base, "mutate", { value: mutate, enumerable: true, writable: false, configurable: false });

	created.proxied = proxy(base);
	handle.unsafeMutable = created.proxied;

	if (groupListeners !== undefined) armWatchdog(created.proxied);

	return get();
}
