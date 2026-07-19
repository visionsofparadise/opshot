// @vitest-environment jsdom

import { createState } from "../createState";

// jsdom implements the DOM in JavaScript, not native code, so its nodes classify as clean- or
// private-field classes rather than the slot-bearing "internal slots" a real browser reports -- the
// message differs by environment, so these assertions pin only that a remedy is offered, not its text.
const domValues: ReadonlyArray<{ readonly name: string; readonly create: () => unknown }> = [
	{ name: "htmlElement", create: () => document.createElement("div") },
	{ name: "documentFragment", create: () => document.createDocumentFragment() },
	{ name: "textNode", create: () => document.createTextNode("catalog") },
	{ name: "blob", create: () => new Blob(["catalog"]) },
];

describe("web DOM globals are rejected at the loud boundary", () => {
	it.each(domValues.map((entry) => [entry.name, entry] as const))("%s throws at create and via mutate", (_name, entry) => {
		expect(() => createState<{ value: unknown }>({ value: entry.create() })).toThrow(/Options:/);

		const state = createState<{ value?: unknown }>({});

		expect(() =>
			state.mutate((mutable) => {
				mutable.value = entry.create();
			}),
		).toThrow(/Options:/);
	});
});
