import { transact } from "../transact/transact";
// @vitest-environment jsdom

import { createMutableState } from "../createMutableState";

// jsdom nodes classify as clean classes; real browsers reject them as native-slot bearers.
const domValues: ReadonlyArray<{ readonly name: string; readonly create: () => unknown }> = [
	{ name: "htmlElement", create: () => document.createElement("div") },
	{ name: "documentFragment", create: () => document.createDocumentFragment() },
	{ name: "textNode", create: () => document.createTextNode("catalog") },
	{ name: "blob", create: () => new Blob(["catalog"]) },
];

describe("web DOM globals under jsdom (clean-class attach)", () => {
	it.each(domValues.map((entry) => [entry.name, entry] as const))(
		"%s attaches at create and via mutate",
		(_name, entry) => {
			const created = createMutableState<{ value: unknown }>({ value: entry.create() });

			expect("value" in created).toBe(true);

			const state = createMutableState<{ value?: unknown }>({});

			transact(state, () => {
				state.value = entry.create();
			});

			expect("value" in state).toBe(true);
		},
	);
});
