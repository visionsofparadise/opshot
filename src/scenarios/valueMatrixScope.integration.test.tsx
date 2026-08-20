// @vitest-environment jsdom

import { act, render, screen } from "../../tests/harness";
import { createElement, type FC } from "react";

import { createMutableState } from "../createMutableState";
import { scope } from "../react/scope";
import { TrackedMap } from "../tracked/trackedMap";
import { transact } from "../transact/transact";

type NestedState = { label: number };

const findLabelled = (root: unknown): { label: number } | undefined => {
	const queue: Array<unknown> = [root];
	const seen = new Set<unknown>();

	while (queue.length > 0) {
		const value = queue.shift();

		if (value === null) continue;

		const type = typeof value;

		if (type !== "object" && type !== "function") continue;
		if (seen.has(value)) continue;

		seen.add(value);

		if (typeof (value as { label?: unknown }).label === "number") return value as { label: number };

		if (Array.isArray(value)) for (const item of value) queue.push(item);
		else if (value instanceof Map || value instanceof TrackedMap) {
			for (const entry of value.entries()) {
				queue.push(entry[0], entry[1]);
			}
		} else for (const key of Object.keys(value as object)) queue.push((value as Record<string, unknown>)[key]);
	}

	return undefined;
};

const buildProbe = (): { Probe: FC<{ holder: unknown }>; renders: { count: number } } => {
	const renders = { count: 0 };

	const Probe = scope<{ holder: unknown }>(({ holder }) => {
		renders.count += 1;

		const found = findLabelled(holder);

		return createElement("span", { "data-testid": "out" }, found ? String(found.label) : "none");
	});

	return { Probe, renders };
};

describe("scope reachability", () => {
	it("skips a state nested in React element props", async () => {
		const nested = createMutableState<NestedState>({ label: 0 });
		const element = createElement("div", { nested });
		const { Probe, renders } = buildProbe();

		render(createElement(Probe, { holder: element }));

		expect(screen.getByTestId("out").textContent).toBe("0");

		const before = renders.count;

		await act(async () => {
			transact(nested, () => {
				nested.label = 1;
			});
		});

		expect(screen.getByTestId("out").textContent).toBe("0");
		expect(renders.count).toBe(before);
	});

	it("traverses a TrackedMap key and discovers a nested state", async () => {
		const key = createMutableState({ label: 0 });
		const map = new TrackedMap<object, string>([[key, "value"]]);
		const { Probe, renders } = buildProbe();

		render(createElement(Probe, { holder: map }));

		expect(screen.getByTestId("out").textContent).toBe("0");

		const before = renders.count;

		await act(async () => {
			transact(key, () => {
				key.label = 1;
			});
		});

		expect(screen.getByTestId("out").textContent).toBe("1");
		expect(renders.count).toBeGreaterThan(before);
	});
});
