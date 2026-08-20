import { createElement, Fragment } from "react";

export { Fragment };

const build = (type: unknown, props: Record<string, unknown> | null, key?: unknown): unknown => {
	const { children, ...rest } = props ?? {};

	if (key !== undefined) rest.key = key;

	const list = children === undefined ? [] : Array.isArray(children) ? children : [children];

	return createElement(type as never, rest, ...(list as Array<never>));
};

export const jsx = build;
export const jsxs = build;
export const jsxDEV = build;
