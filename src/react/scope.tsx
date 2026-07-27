import { createElement, memo, useEffect, useReducer, useRef, type ComponentType, type FC } from "react";
import { getVersion, subscribe as valtioSubscribe } from "valtio/vanilla";
import { isSameIdentity } from "../identity";
import { isState } from "../isState";
import { addressOf } from "../tracked/address";
import { constructorName } from "../utils/constructorName";
import { classifyValue } from "../valtio/classify";
import { createBoundary, type Boundary } from "./boundary";
import { unwrapWrapper } from "./resolveWrapper";

export interface ScopeOptions {
	readonly maxDepth?: number;
}

type PropPath = Array<string | number>;

const isPlainPrototype = (value: object): boolean => {
	const prototype = Reflect.getPrototypeOf(value);

	return prototype === Object.prototype || prototype === null;
};

const assertSubstitutableContainer = (container: object): void => {
	if (isPlainPrototype(container)) return;

	const kind = classifyValue(container);

	if (kind === "plain" || kind === "plainArray" || kind === "cleanClass") return;

	const className = constructorName(container.constructor);

	if (kind === "arraySubclass") {
		throw new Error(
			`opshot: scope found a state inside ${className}, an array subclass whose prototype can't survive substitution. Move the state to a plain array, or ignore() the ${className}.`,
		);
	}

	const hidden = kind === "privateClass" ? "private fields" : "internal slots";

	throw new Error(
		`opshot: scope found a state inside ${className}, whose ${hidden} can't survive substitution. Move the state to a plain container, or ignore() the ${className}.`,
	);
};

function findStatePaths(
	value: unknown,
	maxDepth: number,
	path: PropPath = [],
	paths: Array<PropPath> = [],
	ancestors = new Set<object>(),
): Array<PropPath> {
	if (isState(value)) {
		paths.push(path);

		return paths;
	}

	if (value === null || typeof value !== "object") return paths;

	if ("$$typeof" in value) return paths;

	if (ancestors.has(value)) return paths;

	if (path.length >= maxDepth) return paths;

	ancestors.add(value);

	if (Array.isArray(value)) {
		const foundCount = paths.length;

		value.forEach((item, index) => {
			findStatePaths(item, maxDepth, [...path, index], paths, ancestors);
		});

		if (paths.length > foundCount) assertSubstitutableContainer(value);
	} else {
		const foundCount = paths.length;

		for (const [key, propertyValue] of Object.entries(value)) {
			if (key.startsWith("__react")) continue;

			findStatePaths(propertyValue, maxDepth, [...path, key], paths, ancestors);
		}

		if (paths.length > foundCount) assertSubstitutableContainer(value);
	}

	ancestors.delete(value);

	return paths;
}

function getAtPath(object: unknown, path: PropPath): unknown {
	let current = object;

	for (const segment of path) {
		if (current === null || current === undefined) return undefined;

		current = (current as Record<string | number, unknown>)[segment];
	}

	return current;
}

function setAtPath<T>(object: T, path: PropPath, value: unknown): T {
	if (path.length === 0) return value as T;

	const head = path[0];

	if (head === undefined) throw new Error("setAtPath: non-empty path yielded no head segment");

	const tail = path.slice(1);
	const current = (object as Record<string | number, unknown>)[head];
	const updated = setAtPath(current, tail, value);

	if (Array.isArray(object)) {
		const clone = [...object];

		clone[head as number] = updated;

		return clone as T;
	}

	const prototype = Reflect.getPrototypeOf(object as object);

	if (prototype === Object.prototype || prototype === null) return { ...object, [head]: updated };

	const descriptor = Object.getOwnPropertyDescriptor(object, head);

	if (descriptor?.get !== undefined || descriptor?.set !== undefined) {
		const className = constructorName((object as object).constructor);

		throw new Error(
			`opshot: scope found a state behind the accessor "${String(head)}" on ${className}, which can't survive substitution. Move the state to a plain container, or ignore() the ${className}.`,
		);
	}

	const clone = Object.create(prototype) as Record<string | number, unknown>;

	Object.defineProperties(clone, Object.getOwnPropertyDescriptors(object as object));
	clone[head] = updated;

	return clone as T;
}

const sourcesKey = (sources: Array<object>): string =>
	`${sources.length}:${sources.map((source) => addressOf(source)).join(",")}`;

const arePropsEqual = (previous: object, next: object): boolean => {
	const previousRecord = previous as Record<string, unknown>;
	const nextRecord = next as Record<string, unknown>;
	const keys = Object.keys(previousRecord);

	if (keys.length !== Object.keys(nextRecord).length) return false;

	for (const key of keys) {
		const before = previousRecord[key];
		const after = nextRecord[key];

		if (Object.is(before, after)) continue;

		if (
			typeof before === "object" &&
			before !== null &&
			typeof after === "object" &&
			after !== null &&
			isState(before) &&
			isState(after) &&
			isSameIdentity(before, after)
		) {
			continue;
		}

		return false;
	}

	return true;
};

export function scope<P extends object>(Component: ComponentType<P>, options?: ScopeOptions): FC<P> {
	const maxDepth = options?.maxDepth ?? 10;
	const Scoped: FC<P> = (props) => {
		const boundaryRef = useRef<Boundary | undefined>(undefined);

		boundaryRef.current ??= createBoundary();

		const boundary = boundaryRef.current;
		const [, bump] = useReducer((value: number) => value + 1, 0);

		boundary.resetReads();

		const paths = findStatePaths(props, maxDepth);
		const sources: Array<object> = [];
		let nextProps = props;
		let changed = false;

		for (const path of paths) {
			const value = getAtPath(props, path);

			if (!isState(value)) continue;

			const source = unwrapWrapper(value);

			if (typeof source !== "object" || source === null) continue;

			const wrapped = boundary.wrap(source);

			if (!sources.includes(source)) sources.push(source);

			if (wrapped !== value) {
				nextProps = setAtPath(nextProps, path, wrapped);
				changed = true;
			}
		}

		const renderedProps = changed ? nextProps : props;
		const versionsAtRender = sources.map((source) => getVersion(source));

		useEffect(() => {
			boundary.captureReads();
		});

		useEffect(() => {
			const unsubscribes = sources.map((source) =>
				valtioSubscribe(
					source,
					() => {
						boundary.evictChangedTargets();

						if (boundary.readsChanged(source)) bump();
						else boundary.advanceBaselines();
					},
					true,
				),
			);

			return () => {
				for (const unsubscribe of unsubscribes) unsubscribe();
			};
		}, [sourcesKey(sources), boundary]);

		useEffect(() => {
			let shouldBump = false;

			for (let index = 0; index < sources.length; index += 1) {
				const source = sources[index];
				const captured = versionsAtRender[index];

				if (source === undefined || captured === undefined) continue;

				if (getVersion(source) !== captured) {
					boundary.evictChangedTargets();

					if (boundary.readsChanged(source)) shouldBump = true;
				}
			}

			if (shouldBump) bump();
		});

		return createElement(Component, renderedProps);
	};

	const baseName: unknown = Component.displayName ?? Component.name;

	Scoped.displayName = `scope(${typeof baseName === "string" && baseName !== "" ? baseName : "Component"})`;

	return memo(Scoped, arePropsEqual);
}
