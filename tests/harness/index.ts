import * as React from "react";
import { afterEach } from "vitest";
import { createRoot, legacyAct, legacyRender, legacyUnmount } from "opshot-react-adapter";
import type { ReactElement } from "react";

export { fireEvent, screen, waitFor, within } from "@testing-library/dom";

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean };

reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

type ActFn = (callback: () => unknown) => unknown;
type ReactWithOptionalAct = Omit<typeof React, "act"> & { act?: ActFn };

const rawAct = (React as ReactWithOptionalAct).act ?? legacyAct;

if (rawAct === undefined) throw new TypeError("React act is unavailable");

const versionParts = React.version.split(".").map(Number);
const major = versionParts[0] ?? 0;
const minor = versionParts[1] ?? 0;
const nativeAsyncAct = major > 16 || minor >= 9;

const mounted = new Set<() => void>();

export const cleanup = (): void => {
	for (const unmount of mounted) {
		void rawAct(() => {
			unmount();
		});
	}

	mounted.clear();
};

afterEach(cleanup);

export const act = (callback: () => unknown): undefined | Promise<void> => {
	if (nativeAsyncAct) return rawAct(callback) as undefined | Promise<void>;

	let result: unknown;

	void rawAct(() => {
		result = callback();
	});

	if (typeof (result as Promise<void> | undefined)?.then !== "function") return undefined;

	return (async () => {
		await result;
		await new Promise((resolve) => {
			setTimeout(resolve, 0);
		});
		void rawAct(() => undefined);
	})();
};

export const render = (element: ReactElement) => {
	const container = document.createElement("div");

	document.body.appendChild(container);

	const root = createRoot?.(container);

	const paint = (next: ReactElement): void => {
		void rawAct(() => {
			if (root !== undefined) root.render(next);
			else if (legacyRender !== undefined) legacyRender(next, container);
		});
	};

	const unmount = (): void => {
		if (root !== undefined) root.unmount();
		else if (legacyUnmount !== undefined) legacyUnmount(container);

		container.remove();
	};

	mounted.add(unmount);
	paint(element);

	return { container, rerender: paint, unmount: () => rawAct(unmount) };
};
