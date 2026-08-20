import { createRoot as createConcurrentRoot } from "react-dom/client";
import type { ReactElement } from "react";
import type { Root } from "react-dom/client";

export type CreateRoot = ((container: Element | DocumentFragment) => Root) | undefined;
export type LegacyAct = ((callback: () => unknown) => unknown) | undefined;
export type LegacyRender = ((element: ReactElement, container: Element | DocumentFragment) => unknown) | undefined;
export type LegacyUnmount = ((container: Element | DocumentFragment) => boolean) | undefined;

export const createRoot: CreateRoot = createConcurrentRoot;
export const legacyAct: LegacyAct = undefined;
export const legacyRender: LegacyRender = undefined;
export const legacyUnmount: LegacyUnmount = undefined;
