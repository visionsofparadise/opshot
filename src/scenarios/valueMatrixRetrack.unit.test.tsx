// @vitest-environment jsdom

import { act, render, screen } from "@testing-library/react";
import { createElement, type FC } from "react";

import { createState, type State } from "../createState";
import { retrack } from "../react/retrack";
import { TrackedDate } from "../tracked/trackedDate";
import { TrackedMap } from "../tracked/trackedMap";
import { TrackedSet } from "../tracked/trackedSet";
import { isTrackedWrapper } from "../tracked/trackedWrapper";
import { classifyValue } from "../valtio/boundary";
import { catalog, type CatalogEntry } from "./valueCatalog";

type NestedState = State<{ label: number }>;

type Verdict = "found" | "throws" | "skipped";

const hasTrackedBrand = (value: object): boolean => isTrackedWrapper(value);

const walkVerdict = (container: unknown): Verdict => {
	if (container === null || typeof container === "function") return "skipped";
	if (typeof container !== "object") return "skipped";
	if ("$$typeof" in container) return "skipped";

	if (hasTrackedBrand(container)) {
		const tag: unknown = Reflect.get(container, Symbol.toStringTag);

		return tag === "TrackedMap" || tag === "TrackedSet" ? "found" : "skipped";
	}

	if (container instanceof Map || container instanceof Set) return "skipped";

	if (Array.isArray(container)) {
		const prototype = Object.getPrototypeOf(container) as object | null;

		return prototype === Array.prototype || prototype === null ? "found" : "throws";
	}

	const prototype = Object.getPrototypeOf(container) as object | null;

	if (prototype === Object.prototype || prototype === null) return "found";

	return classifyValue(container) === "cleanClass" ? "found" : "throws";
};

const injectState = (container: object, state: NestedState): void => {
	if (Array.isArray(container)) container.push(state);
	else if (container instanceof TrackedMap) container.set("nested", state.op.unsafeMutable);
	else if (container instanceof TrackedSet) container.add(state.op.unsafeMutable);
	else if (container instanceof Map) container.set("nested", state);
	else if (container instanceof Set) container.add(state);
	else Reflect.set(container, "nested", state);
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
		else if (value instanceof Map || value instanceof TrackedMap) for (const entry of value.values()) queue.push(entry);
		else if (value instanceof Set || value instanceof TrackedSet) for (const entry of value) queue.push(entry);
		else for (const key of Object.keys(value as object)) queue.push((value as Record<string, unknown>)[key]);
	}

	return undefined;
};

const buildProbe = (): { Probe: FC<{ holder: unknown }>; renders: { count: number } } => {
	const renders = { count: 0 };

	const Probe = retrack<{ holder: unknown }>(({ holder }) => {
		renders.count += 1;

		const found = findLabelled(holder);

		return createElement("span", { "data-testid": "out" }, found ? String(found.label) : "none");
	});

	return { Probe, renders };
};

const retrackApplies = (entry: CatalogEntry): boolean => {
	if (entry.lane === "registeredCopy") return false;

	const value = entry.create();

	if (value === null) return false;

	const type = typeof value;

	if (type !== "object" && type !== "function") return false;
	if (value instanceof Date || value instanceof TrackedDate) return false;
	if (Object.isFrozen(value) && !("$$typeof" in (value as object))) return false;

	return true;
};

const runRetrackRow = async (entry: CatalogEntry): Promise<void> => {
	const nested = createState<{ label: number }>({ label: 0 });
	const container = entry.name === "reactElement" ? createElement("div", { nested }) : entry.create();

	if (entry.name !== "reactElement") injectState(container as object, nested);

	const verdict = walkVerdict(container);
	const { Probe, renders } = buildProbe();

	if (verdict === "throws") {
		const consoleError = console.error;

		console.error = (): void => undefined;

		try {
			expect(() => render(createElement(Probe, { holder: container }))).toThrow(/retrack found a state/);
		} finally {
			console.error = consoleError;
		}

		return;
	}

	render(createElement(Probe, { holder: container }));

	expect(screen.getByTestId("out").textContent).toBe("0");

	const before = renders.count;

	await act(async () => {
		nested.mutate((mutable) => {
			mutable.label = 1;
		});
	});

	if (verdict === "found") {
		expect(screen.getByTestId("out").textContent).toBe("1");
		expect(renders.count).toBeGreaterThan(before);
	} else {
		expect(screen.getByTestId("out").textContent).toBe("0");
		expect(renders.count).toBe(before);
	}
};

describe("value matrix retrack walk", () => {
	const applicable = catalog.filter(retrackApplies);

	for (const entry of applicable) it(entry.name, async () => runRetrackRow(entry));

	it("does not traverse a TrackedMap key", async () => {
		const key = createState({ label: 0 });
		const map = new TrackedMap<object, string>([[key.op.unsafeMutable, "value"]]);
		const { Probe, renders } = buildProbe();

		render(createElement(Probe, { holder: map }));

		expect(screen.getByTestId("out").textContent).toBe("none");

		const before = renders.count;

		await act(async () => {
			key.mutate((mutable) => {
				mutable.label = 1;
			});
		});

		expect(screen.getByTestId("out").textContent).toBe("none");
		expect(renders.count).toBe(before);
	});
});
