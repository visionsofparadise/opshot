// @vitest-environment jsdom

import { createState } from "../createState";

// jsdom implements the DOM in JavaScript, not native code, so its nodes classify as clean classes
// (no `#`, no `[native code]`, no own-enumerable functions) and now attach under the clean-class
// tracking rule. Real browsers still reject them as native-slot bearers. These pins document the
// jsdom path only.
const domValues: ReadonlyArray<{ readonly name: string; readonly create: () => unknown }> = [
	{ name: "htmlElement", create: () => document.createElement("div") },
	{ name: "documentFragment", create: () => document.createDocumentFragment() },
	{ name: "textNode", create: () => document.createTextNode("catalog") },
	{ name: "blob", create: () => new Blob(["catalog"]) },
];

describe("web DOM globals under jsdom (clean-class attach)", () => {
	it.each(domValues.map((entry) => [entry.name, entry] as const))("%s attaches at create and via mutate", (_name, entry) => {
		const created = createState<{ value: unknown }>({ value: entry.create() });

		expect("value" in created.op.unwrap()).toBe(true);

		const state = createState<{ value?: unknown }>({});

		state.mutate((mutable) => {
			mutable.value = entry.create();
		});

		expect("value" in state.op.unwrap()).toBe(true);
	});
});
