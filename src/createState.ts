import { proxy, ref, snapshot, subscribe as valtioSubscribe, type Snapshot } from "valtio/vanilla";
import { installBoundary } from "./boundary";
import { diffSnapshots, getCyclicErrorPointer, type Op } from "./diff";
import { parseWrapperNotification, type WrapperPayload } from "./trackedWrapper";

installBoundary();

export type MetaRecord = Record<string, unknown>;

declare const metaIn: unique symbol;
export interface Meta<In extends object = MetaRecord, Out extends object = MetaRecord> {
	readonly defaults?: Out;
	readonly [metaIn]?: (value: In) => void; // phantom: keeps In inferable; never present at runtime
}

export type Emission<Out extends object = MetaRecord> =
	| { readonly isSideEffect: false; readonly meta: Out }
	| { readonly isSideEffect: true };

export type Mutate<T extends object, In extends object = MetaRecord> = (callback: (mutable: T) => void, ...meta: {} extends In ? [meta?: In] : [meta: In]) => void;
export type StateListener<T extends object, In extends object = MetaRecord, Out extends object = MetaRecord> = (state: State<T, In, Out>, ops: Array<Op>, emission: Emission<Out>) => void;

export interface OpshotHandle<T extends object, In extends object = MetaRecord, Out extends object = MetaRecord> {
	readonly unsafeMutable: object;
	readonly isMutating: boolean;
	readonly subscribe: (listener: StateListener<T, In, Out>) => () => void;
	readonly isSameState: (other: unknown) => boolean;
	readonly unwrap: () => Snapshot<T>;
}

export type State<T extends object, In extends object = MetaRecord, Out extends object = MetaRecord> = Snapshot<T> & {
	readonly mutate: Mutate<T, In>;
	readonly op: OpshotHandle<T, In, Out>;
};

export type DefineCallback<T extends object, In extends object = MetaRecord, Out extends object = MetaRecord> = (mutate: Mutate<T, In>, get: () => State<T, In, Out>) => T;
export type Define<T extends object, In extends object = MetaRecord, Out extends object = MetaRecord> = DefineCallback<T, In, Out> | T;

const stateBrand: unique symbol = Symbol.for("opshot.state");
const metaBrand: unique symbol = Symbol.for("opshot.meta");

interface BrandedMeta<In extends object, Out extends object> extends Meta<In, Out> {
	readonly [metaBrand]: true;
}

interface MutableOpshotHandle<T extends object, In extends object, Out extends object> {
	unsafeMutable: object;
	isMutating: boolean;
	readonly subscribe: (listener: StateListener<T, In, Out>) => () => void;
	readonly isSameState: (other: unknown) => boolean;
	readonly unwrap: () => Snapshot<T>;
	readonly [stateBrand]: true;
}

const hasOwn = <K extends PropertyKey>(value: object, key: K): value is Record<K, unknown> => Object.hasOwn(value, key);

export const augmentSideEffectCycleError = (error: unknown): Error | undefined => {
	const pointer = getCyclicErrorPointer(error);

	if (pointer === undefined) return undefined;

	return new Error(
		`opshot: a side-effect write created a cyclic value at ${pointer}. Cycles cannot be tracked. This surfaced asynchronously because the write bypassed mutate (an unsafeMutable write, or a shared/entangled state). Use ignore() for back-linked structures, or ids.`,
	);
};

export function createMeta<M extends object>(): Meta<M, M>;
export function createMeta<M extends object>(defaults: M): Meta<Partial<M>, M>;
export function createMeta<M extends object>(defaults?: M): Meta<Partial<M>, M> {
	const token: BrandedMeta<Partial<M>, M> = defaults === undefined ? { [metaBrand]: true } : { defaults, [metaBrand]: true };

	return token;
}

export function isMeta(value: unknown): value is Meta<object, object> {
	if (typeof value !== "object" || value === null || !hasOwn(value, metaBrand)) return false;

	return value[metaBrand] === true;
}

export function createState<T extends object>(define: Define<T>): State<T>;
export function createState<T extends object, In extends object, Out extends object>(define: Define<T, In, Out>, meta: Meta<In, Out>): State<T, In, Out>;
export function createState<T extends object, In extends object, Out extends object>(define: Define<T, In, Out>, meta?: Meta<In, Out>): State<T, In, Out> {
	return createGroupState(define, undefined, meta);
}

export function createGroupState<T extends object, In extends object = MetaRecord, Out extends object = MetaRecord>(
	define: Define<T, In, Out>,
	groupListeners?: Set<StateListener<object, In, Out>>,
	metaToken?: Meta<In, Out>,
): State<T, In, Out> {
	const callback: DefineCallback<T, In, Out> = typeof define === "function" ? define : () => define;

	const listeners = new Set<StateListener<T, In, Out>>();
	const created: { proxied?: T } = {};

	// Wrapper payloads mutate's sync collector already folded into an owned emission; the watchdog
	// skips them so an inside-mutate wrapper call never emits twice. Per state, since an entangled
	// wrapper's payload reaches every attached state's subscription and each stream is independent.
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

		// Ordinary writes deliver empty op payloads without unstable_enableOp (probe 1.4), so the watchdog
		// diffs snapshots itself; the delivered ops carry only the explicit tracked-wrapper entries, which
		// snapshot diffing cannot see (wrappers are identity-stable leaves) and which convert directly.
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

		// Wrapper commands surface only through valtio's notification channel; this temporary synchronous
		// subscription over the mutate window folds them into the same owned emission. Attached only when
		// emission will run -- the watchdog then already holds the persistent subscription, so this pays
		// no 0->1 listener cascade (probe 1.4).
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

	const isSameState = (other: unknown): boolean => isState(other) && (other.op as unknown) === handle;

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

export function isState(value: unknown): value is State<object> {
	if (typeof value !== "object" || value === null || !hasOwn(value, "op")) return false;

	const handle = value.op;

	if (typeof handle !== "object" || handle === null || !hasOwn(handle, stateBrand)) return false;

	return handle[stateBrand] === true;
}
