import { memo, useMemo, type FC } from "react";
import { isState } from "../isState";
import { constructorName } from "../valtio/boundary";
import { classifyValue } from "../valtio/classify";
import { useRetrackAll } from "./tracking";

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
		throw new Error(`opshot: retrack found a state inside ${className}, an array subclass whose prototype can't survive substitution. Move the state to a plain array, or ignore() the ${className}.`);
	}

	const hidden = kind === "privateClass" ? "private fields" : "internal slots";

	throw new Error(`opshot: retrack found a state inside ${className}, whose ${hidden} can't survive substitution. Move the state to a plain container, or ignore() the ${className}.`);
};

function findStatePaths(value: unknown, maxDepth: number, path: PropPath = [], paths: Array<PropPath> = [], ancestors = new Set<object>()): Array<PropPath> {
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
			// React stamps fiber refs onto DOM nodes under __react-prefixed keys; descending one would drag the fiber graph into the walk.
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
			`opshot: retrack found a state behind the accessor "${String(head)}" on ${className}, which can't survive substitution. Move the state to a plain container, or ignore() the ${className}.`,
		);
	}

	const clone = Object.create(prototype) as Record<string | number, unknown>;

	Object.defineProperties(clone, Object.getOwnPropertyDescriptors(object as object));
	clone[head] = updated;

	return clone as T;
}

export interface RetrackOptions {
	readonly maxDepth?: number;
}

export function retrack<P extends object>(component: FC<P>, options?: RetrackOptions): FC<P> {
	const componentName = component.displayName ?? component.name;
	const maxDepth = options?.maxDepth ?? 10;

	const Retracked: FC<P> = (props) => {
		const snapshotPaths = useMemo(() => findStatePaths(props, maxDepth), [props]);
		const staleStates = useMemo(() => snapshotPaths.map((path) => getAtPath(props, path)).filter(isState), [props, snapshotPaths]);
		const freshStates = useRetrackAll(staleStates);

		const freshProps = useMemo(() => {
			if (freshStates === staleStates) return props;

			return snapshotPaths.reduce<P>((acc, path, index) => setAtPath(acc, path, freshStates[index]), props);
		}, [props, snapshotPaths, staleStates, freshStates]);

		return component(freshProps);
	};

	Retracked.displayName = `retrack(${componentName === "" ? "Anonymous" : componentName})`;

	return memo(Retracked);
}
