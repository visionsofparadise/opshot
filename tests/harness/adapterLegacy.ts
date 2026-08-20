import reactDom from "react-dom";
import { act } from "react-dom/test-utils";
import type { CreateRoot, LegacyAct, LegacyRender, LegacyUnmount } from "./adapterModern";

interface ReactDomLegacy {
	render: NonNullable<LegacyRender>;
	unmountComponentAtNode: NonNullable<LegacyUnmount>;
}

const reactDomLegacy = reactDom as typeof reactDom & ReactDomLegacy;

export const createRoot: CreateRoot = undefined;
// eslint-disable-next-line @typescript-eslint/no-deprecated
export const legacyAct: LegacyAct = act;
export const legacyRender: LegacyRender = reactDomLegacy.render;
export const legacyUnmount: LegacyUnmount = reactDomLegacy.unmountComponentAtNode;
