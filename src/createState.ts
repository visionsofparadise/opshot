import { proxy, ref, snapshot, type Snapshot } from "valtio/vanilla";
import { diffSnapshots, type Op } from "./diff";

export type MutateOptions = Record<string, unknown>;
export type Mutate<T extends object> = (callback: (proxy: T) => void, options?: MutateOptions) => void;
export type StateListener<T extends object> = (state: State<T>, ops: Array<Op>, options: MutateOptions) => void;

export interface OpshotHandle<T extends object> {
	readonly proxy: object;
	readonly isMutating: boolean;
	readonly mutate: Mutate<T>;
	readonly subscribe: (listener: StateListener<T>) => () => void;
	readonly isSameState: (other: unknown) => boolean;
	readonly unwrap: () => Snapshot<T>;
}

export type State<T extends object> = Snapshot<T> & {
	readonly op: OpshotHandle<T>;
};

export type DefineCallback<T extends object> = (mutate: Mutate<T>, get: () => State<T>) => T;
export type Define<T extends object> = DefineCallback<T> | T;

const stateBrand: unique symbol = Symbol.for("opshot.state");

interface MutableOpshotHandle<T extends object> {
	proxy: object;
	isMutating: boolean;
	readonly mutate: Mutate<T>;
	readonly subscribe: (listener: StateListener<T>) => () => void;
	readonly isSameState: (other: unknown) => boolean;
	readonly unwrap: () => Snapshot<T>;
	readonly [stateBrand]: true;
}

const hasOwn = <K extends PropertyKey>(value: object, key: K): value is Record<K, unknown> => Object.hasOwn(value, key);

export function createState<T extends object>(define: Define<T>): State<T> {
	return createGroupState(define);
}

export function createGroupState<T extends object>(define: Define<T>, groupListeners?: Set<StateListener<object>>): State<T> {
	const callback: DefineCallback<T> = typeof define === "function" ? define : () => define;

	const listeners = new Set<StateListener<T>>();
	const created: { proxied?: T } = {};

	const requireProxy = (): T => {
		const { proxied } = created;

		if (!proxied) throw new Error("opshot: called during createState definition");

		return proxied;
	};

	const get = (): State<T> => snapshot(requireProxy()) as State<T>;

	const mutate: Mutate<T> = (callback, options = {}) => {
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

		for (const listener of [...(groupListeners ?? [])]) listener(after as State<T>, ops, options);
		for (const listener of [...listeners]) listener(after as State<T>, ops, options);
	};

	const subscribe = (listener: StateListener<T>): (() => void) => {
		listeners.add(listener);

		return () => {
			listeners.delete(listener);
		};
	};

	const isSameState = (other: unknown): boolean => isState(other) && other.op === handle;

	const unwrap = (): Snapshot<T> => {
		const { op, ...rest } = get();

		return rest as Snapshot<T>;
	};

	const literal = callback(mutate, get);

	if (Object.hasOwn(literal, "op")) throw new Error('opshot: "op" is a reserved key on a state');

	const base = Object.create(Reflect.getPrototypeOf(literal)) as T;

	Object.defineProperties(base, Object.getOwnPropertyDescriptors(literal));

	const handle: MutableOpshotHandle<T> = { proxy: base, isMutating: false, mutate, subscribe, isSameState, unwrap, [stateBrand]: true };

	Object.defineProperty(base, "op", { value: ref(handle), enumerable: true, writable: false, configurable: false });

	created.proxied = proxy(base);
	handle.proxy = created.proxied;

	return get();
}

export function isState(value: unknown): value is State<object> {
	if (typeof value !== "object" || value === null || !hasOwn(value, "op")) return false;

	const handle = value.op;

	if (typeof handle !== "object" || handle === null || !hasOwn(handle, stateBrand)) return false;

	return handle[stateBrand] === true;
}
