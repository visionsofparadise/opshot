import { proxy, ref, snapshot, type Snapshot } from "valtio/vanilla";
import { diffSnapshots, type Op } from "./diff";

export type MetaRecord = Record<string, unknown>;

declare const metaIn: unique symbol;
export interface Meta<In extends object = MetaRecord, Out extends object = MetaRecord> {
	readonly defaults?: Out;
	readonly [metaIn]?: (value: In) => void; // phantom: keeps In inferable; never present at runtime
}

export type Mutate<T extends object, In extends object = MetaRecord> = (callback: (mutable: T) => void, ...meta: {} extends In ? [meta?: In] : [meta: In]) => void;
export type StateListener<T extends object, In extends object = MetaRecord, Out extends object = MetaRecord> = (state: State<T, In, Out>, ops: Array<Op>, meta: Out) => void;

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

	const requireProxy = (): T => {
		const { proxied } = created;

		if (!proxied) throw new Error("opshot: called during createState definition");

		return proxied;
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

		if (before === after) return;

		if (listeners.size === 0 && (groupListeners?.size ?? 0) === 0) return;

		const ops = diffSnapshots(before, after);

		if (ops.length === 0) return;

		const emittedMeta = (metaToken?.defaults !== undefined ? { ...metaToken.defaults, ...meta } : (meta ?? {})) as Out;

		for (const listener of [...(groupListeners ?? [])]) listener(after as State<T, In, Out>, ops, emittedMeta);
		for (const listener of [...listeners]) listener(after as State<T, In, Out>, ops, emittedMeta);
	};

	const subscribe = (listener: StateListener<T, In, Out>): (() => void) => {
		listeners.add(listener);

		return () => {
			listeners.delete(listener);
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

	return get();
}

export function isState(value: unknown): value is State<object> {
	if (typeof value !== "object" || value === null || !hasOwn(value, "op")) return false;

	const handle = value.op;

	if (typeof handle !== "object" || handle === null || !hasOwn(handle, stateBrand)) return false;

	return handle[stateBrand] === true;
}
