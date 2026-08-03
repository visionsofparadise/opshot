// @vitest-environment jsdom

import * as React from "react";
import * as ReactDOM from "react-dom";
import { createRoot } from "react-dom/client";

interface ReactDispatcherSlots {
	readonly __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE?: unknown;
	readonly __SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED?: { ReactCurrentDispatcher?: { current?: unknown } };
}

const loadDetector = async (): Promise<typeof import("./renderPhase")> => {
	vi.resetModules();

	return import("./renderPhase");
};

const mountProbe = (detector: typeof import("./renderPhase")) => {
	const container = document.createElement("div");

	document.body.appendChild(container);

	const root = createRoot(container);
	const phasesDuringRender: Array<boolean> = [];

	const Probe: React.FC = () => {
		phasesDuringRender.push(detector.isRendering());

		return <span>probe</span>;
	};

	const renderProbe = async (): Promise<void> => {
		await React.act(async () => {
			root.render(<Probe />);
		});
	};

	return { phasesDuringRender, renderProbe };
};

describe("renderPhase against a real React 18", () => {
	beforeAll(() => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	});

	it("resolves react and react-dom at the nested React 18 install", () => {
		expect(React.version).toMatch(/^18\./);
		expect(ReactDOM.version).toMatch(/^18\./);
	});

	it("answers not-rendering until the non-render dispatcher is learned", async () => {
		const detector = await loadDetector();
		const { phasesDuringRender, renderProbe } = mountProbe(detector);

		await renderProbe();

		expect(phasesDuringRender).toEqual([false]);

		detector.learnNonRenderDispatcher();

		expect(detector.isRendering()).toBe(false);

		await renderProbe();

		expect(phasesDuringRender).toEqual([false, true]);
		expect(detector.isRendering()).toBe(false);
	});

	it("reads React 18's dispatcher slot when React 19's is absent", async () => {
		const internals = React as unknown as ReactDispatcherSlots;

		expect(internals.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE).toBeUndefined();
		expect(internals.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED?.ReactCurrentDispatcher).toBeDefined();

		const detector = await loadDetector();
		const { phasesDuringRender, renderProbe } = mountProbe(detector);

		await renderProbe();

		detector.learnNonRenderDispatcher();

		const learned = internals.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED?.ReactCurrentDispatcher?.current;

		expect(learned).toBeDefined();

		await renderProbe();

		expect(phasesDuringRender).toEqual([false, true]);
		expect(internals.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED?.ReactCurrentDispatcher?.current).toBe(
			learned,
		);
	});
});
