// eslint-disable-next-line barrel-files/avoid-namespace-import
import * as React from "react";

interface ReactDispatcherInternals {
	readonly __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE?: { H?: unknown };
	readonly __SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED?: { ReactCurrentDispatcher?: { current?: unknown } };
}

const NO_SLOT: unique symbol = Symbol("opshot.noDispatcherSlot");

const readDispatcher = (): unknown => {
	const internals = React as unknown as ReactDispatcherInternals;
	const modern = internals.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;

	if (modern !== undefined) return modern.H;

	const legacy = internals.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED?.ReactCurrentDispatcher;

	if (legacy !== undefined) return legacy.current;

	return NO_SLOT;
};

let nonRenderDispatcher: unknown;

export const learnNonRenderDispatcher = (): void => {
	const current = readDispatcher();

	if (current === NO_SLOT || current === null || current === undefined) return;

	nonRenderDispatcher = current;
};

export const isRendering = (): boolean => {
	if (nonRenderDispatcher === undefined) return false;

	const current = readDispatcher();

	if (current === NO_SLOT || current === null || current === undefined) return false;

	return current !== nonRenderDispatcher;
};
