// @vitest-environment jsdom

import { act, render, screen } from "@testing-library/react";
import { createElement, type FC } from "react";

import { createMutableState } from "../createMutableState";
import { scope } from "../react/scope";
import { TrackedMap } from "../tracked/trackedMap";
import { TrackedSet } from "../tracked/trackedSet";
import { transact } from "../transact/transact";
import { catalog, scopeBehaviorNames, type ScopeBehaviorName } from "./valueCatalog";

type NestedState = { label: number };

const injectState = (container: object, state: NestedState): boolean => {
	if (Array.isArray(container)) {
		const index = container.length;

		container.push(state);

		return container[index] === state;
	}

	if (container instanceof TrackedMap) {
		container.set("nested", state);

		return container.get("nested") === state;
	}

	if (container instanceof TrackedSet) {
		container.add(state);

		return container.has(state);
	}

	if (container instanceof Map) {
		container.set("nested", state);

		return container.get("nested") === state;
	}

	if (container instanceof Set) {
		container.add(state);

		return container.has(state);
	}

	return Reflect.set(container, "nested", state);
};

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
		} else if (value instanceof Set || value instanceof TrackedSet) for (const entry of value) queue.push(entry);
		else for (const key of Object.keys(value as object)) queue.push((value as Record<string, unknown>)[key]);
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

const isApplicable = (create: () => unknown): boolean => {
	const value = create();

	if (value === null || typeof value !== "object") return false;

	return injectState(value, createMutableState({ label: 0 }));
};

const scenarios = {
	rendersOnChange: async (create) => {
		try {
			const nested = createMutableState<NestedState>({ label: 0 });
			const container = create();

			if (container === null || typeof container !== "object") return false;
			if (!injectState(container, nested)) return false;

			const { Probe, renders } = buildProbe();

			const consoleError = console.error;

			console.error = (): void => undefined;

			try {
				render(createElement(Probe, { holder: container }));
			} catch {
				return false;
			} finally {
				console.error = consoleError;
			}

			if (screen.getByTestId("out").textContent !== "0") return false;

			const before = renders.count;

			await act(async () => {
				transact(nested, () => {
					nested.label = 1;
				});
			});

			return screen.getByTestId("out").textContent === "1" && renders.count > before;
		} catch {
			return false;
		}
	},

	walkThrows: (create) => {
		try {
			const nested = createMutableState<NestedState>({ label: 0 });
			const container = create();

			if (container === null || typeof container !== "object") return false;
			if (!injectState(container, nested)) return false;

			const { Probe } = buildProbe();
			const consoleError = console.error;

			console.error = (): void => undefined;

			try {
				render(createElement(Probe, { holder: container }));

				return false;
			} catch {
				return true;
			} finally {
				console.error = consoleError;
			}
		} catch {
			return false;
		}
	},
} satisfies Record<ScopeBehaviorName, (create: () => unknown) => boolean | Promise<boolean>>;

describe("value matrix scope", () => {
	it("scopeExpect completeness both directions", () => {
		for (const entry of catalog) {
			const applicable = isApplicable(entry.create);

			if (applicable) expect(entry.scopeExpect, `${entry.name} applicable`).toBeDefined();
			else expect(entry.scopeExpect, `${entry.name} inapplicable`).toBeUndefined();
		}
	});

	for (const entry of catalog) {
		if (!isApplicable(entry.create)) continue;

		for (const name of scopeBehaviorNames) {
			it(`${entry.name} / ${name}`, async () => {
				const expected = entry.scopeExpect?.[name];

				expect(expected, `${entry.name} missing scopeExpect.${name}`).toBeDefined();
				expect(await scenarios[name](entry.create)).toBe(expected);
			});
		}
	}

	it("skips a state nested on a DOM node", async () => {
		const nested = createMutableState<NestedState>({ label: 0 });
		const node = document.createElement("div");

		Object.assign(node, { nested });

		const { Probe, renders } = buildProbe();

		render(createElement(Probe, { holder: node }));

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
