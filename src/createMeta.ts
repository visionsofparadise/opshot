import { hasOwn } from "./utils/hasOwn";

declare const metaIn: unique symbol;

/**
 * Meta token for `mutate` and subscribers.
 *
 * @typeParam In - Meta accepted by `mutate`.
 * @typeParam Out - Meta delivered to listeners.
 */
export interface Meta<In extends object = {}, Out extends object = {}> {
	readonly defaults?: Out;
	readonly [metaIn]?: (value: In) => void; // phantom: keeps In inferable; never present at runtime
}

const metaBrand: unique symbol = Symbol.for("opshot.meta");

interface BrandedMeta<In extends object, Out extends object> extends Meta<In, Out> {
	readonly [metaBrand]: true;
}

/**
 * Declares a meta type for `mutate` and subscribers.
 *
 * @typeParam M - Meta shape.
 * @param defaults - Optional defaults merged into each call's meta.
 * @returns A meta token.
 */
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
