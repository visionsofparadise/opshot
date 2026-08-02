import { createMutableState } from "./createMutableState";
import { type Op } from "./ops/operation";
import { subscribe } from "./subscribe";
import { transact } from "./transact";

describe("transact", () => {
	it("runs the mutate callback and emits ops with meta when subscribed", () => {
		const state = createMutableState({ count: 0 });
		const heard = new Array<{ ops: Array<Op>; meta: unknown }>();

		subscribe(state, (ops, meta) => {
			heard.push({ ops: [...ops], meta });
		});

		transact(
			state,
			() => {
				state.count = 3;
			},
			{ reason: "test" },
		);

		expect(state.count).toBe(3);
		expect(heard).toEqual([
			{
				ops: [
					{ do: { op: "assign", path: ["count"], value: 3 }, undo: { op: "assign", path: ["count"], value: 0 } },
				],
				meta: { reason: "test" },
			},
		]);
	});

	it("runs the mutate callback with no record when nothing listens", () => {
		const state = createMutableState({ count: 0 });

		transact(
			state,
			() => {
				state.count = 4;
			},
			{ ignored: true },
		);

		expect(state.count).toBe(4);
	});

	it("delivers meta above, below, and at the transacted node, and nothing to a sibling", () => {
		const state = createMutableState({ a: { deep: { n: 0 } }, b: { n: 0 } });
		const heard: Record<string, Array<unknown>> = { root: [], a: [], deep: [], b: [] };

		subscribe(state, (_ops, meta) => heard.root?.push(meta));
		subscribe(state.a, (_ops, meta) => heard.a?.push(meta));
		subscribe(state.a.deep, (_ops, meta) => heard.deep?.push(meta));
		subscribe(state.b, (_ops, meta) => heard.b?.push(meta));

		transact(
			state.a,
			() => {
				state.a.deep.n = 1;
			},
			{ tag: "mine" },
		);

		expect(heard).toEqual({ root: [{ tag: "mine" }], a: [{ tag: "mine" }], deep: [{ tag: "mine" }], b: [] });
	});

	it("delivers meta to a node below the root when the transact is at the root", () => {
		const state = createMutableState({ a: { deep: { n: 0 } } });
		const heard = new Array<unknown>();

		subscribe(state.a.deep, (_ops, meta) => heard.push(meta));

		transact(
			state,
			() => {
				state.a.deep.n = 1;
			},
			{ replay: true },
		);

		expect(heard).toEqual([{ replay: true }]);
	});

	it("never carries an inner transaction's meta on an outer transaction's writes", () => {
		const state = createMutableState({ top: 0, a: { n: 0 } });
		const rootHeard = new Array<{ ops: Array<Op>; meta: unknown }>();
		const innerHeard = new Array<unknown>();

		subscribe(state, (ops, meta) => rootHeard.push({ ops: [...ops], meta }));
		subscribe(state.a, (_ops, meta) => innerHeard.push(meta));

		transact(
			state,
			() => {
				state.top = 1;

				transact(
					state.a,
					() => {
						state.a.n = 1;
					},
					{ tag: "inner" },
				);

				state.top = 2;
			},
			{ tag: "outer" },
		);

		expect(rootHeard).toHaveLength(1);
		expect(rootHeard[0]?.meta).toEqual({ tag: "outer" });
		expect(rootHeard[0]?.ops).toEqual([
			{ do: { op: "assign", path: ["top"], value: 2 }, undo: { op: "assign", path: ["top"], value: 0 } },
			{ do: { op: "assign", path: ["a", "n"], value: 1 }, undo: { op: "assign", path: ["a", "n"], value: 0 } },
		]);
		expect(innerHeard).toEqual([{ tag: "inner" }]);
	});

	it("never carries an inner transaction's meta when the outer has not yet written", () => {
		const state = createMutableState({ top: 0, a: { n: 0 } });
		const rootHeard = new Array<{ ops: Array<Op>; meta: unknown }>();
		const innerHeard = new Array<unknown>();

		subscribe(state, (ops, meta) => rootHeard.push({ ops: [...ops], meta }));
		subscribe(state.a, (_ops, meta) => innerHeard.push(meta));

		transact(
			state,
			() => {
				transact(
					state.a,
					() => {
						state.a.n = 1;
					},
					{ tag: "inner" },
				);

				state.top = 2;
			},
			{ tag: "outer" },
		);

		expect(rootHeard).toHaveLength(1);
		expect(rootHeard[0]?.meta).toEqual({ tag: "outer" });
		expect(rootHeard[0]?.ops).toEqual([
			{ do: { op: "assign", path: ["top"], value: 2 }, undo: { op: "assign", path: ["top"], value: 0 } },
			{ do: { op: "assign", path: ["a", "n"], value: 1 }, undo: { op: "assign", path: ["a", "n"], value: 0 } },
		]);
		expect(innerHeard).toEqual([{ tag: "inner" }]);
	});

	it("never leaks an inner replay flag onto the enclosing transaction's own emission", () => {
		const state = createMutableState({ a: { n: 0 } });
		const rootHeard = new Array<unknown>();

		subscribe(state, (_ops, meta) => rootHeard.push(meta));

		transact(
			state,
			() => {
				transact(
					state.a,
					() => {
						state.a.n = 1;
					},
					{ replay: true },
				);
			},
			{ transactionKey: "user-drag" },
		);

		expect(rootHeard).toEqual([{ transactionKey: "user-drag" }]);
	});

	it("gives the outermost transaction every record but each nested transaction's own node", () => {
		const state = createMutableState({ a: { n: 0 }, b: { n: 0 } });
		const heard: Record<string, Array<unknown>> = { root: [], a: [], b: [] };

		subscribe(state, (_ops, meta) => heard.root?.push(meta));
		subscribe(state.a, (_ops, meta) => heard.a?.push(meta));
		subscribe(state.b, (_ops, meta) => heard.b?.push(meta));

		transact(
			state,
			() => {
				transact(
					state.a,
					() => {
						state.a.n = 1;
					},
					{ tag: "a" },
				);
				transact(
					state.b,
					() => {
						state.b.n = 1;
					},
					{ tag: "b" },
				);
			},
			{ tag: "outer" },
		);

		expect(heard).toEqual({ root: [{ tag: "outer" }], a: [{ tag: "a" }], b: [{ tag: "b" }] });
	});

	it("isolates each record's report and raises after the loop", () => {
		const state = createMutableState({ a: { n: 0 } });
		const heard = new Array<string>();
		const failure = new Error("root listener failure");

		subscribe(state, () => {
			heard.push("root");

			throw failure;
		});
		subscribe(state.a, () => heard.push("a"));

		expect(() =>
			transact(state, () => {
				state.a.n = 1;
			}),
		).toThrow(failure);
		expect([...heard].sort()).toEqual(["a", "root"]);
	});

	it("reports a node holding undelivered bare writes as bare, and carries meta once its window has closed", async () => {
		const state = createMutableState({ a: { n: 0 }, bare: 0 });
		const heard = new Array<unknown>();

		subscribe(state, (_ops, meta) => heard.push(meta));

		state.bare = 1;

		transact(
			state.a,
			() => {
				state.a.n = 1;
			},
			{ tag: "mine" },
		);

		expect(heard).toEqual([undefined]);

		await Promise.resolve();

		transact(
			state.a,
			() => {
				state.a.n = 2;
			},
			{ tag: "mine" },
		);

		expect(heard).toEqual([undefined, { tag: "mine" }]);
	});

	it("hands a claimed node to its own window when mutate throws", async () => {
		const state = createMutableState({ a: { n: 0 } });
		const heard = new Array<unknown>();

		subscribe(state, (_ops, meta) => heard.push(meta));

		expect(() =>
			transact(
				state.a,
				() => {
					state.a.n = 1;

					throw new Error("mutate failure");
				},
				{ tag: "mine" },
			),
		).toThrow("mutate failure");
		expect(heard).toEqual([]);

		await Promise.resolve();

		expect(heard).toEqual([undefined]);
	});

	it("reports every covering node exactly once, in no promised order", () => {
		const state = createMutableState({ a: { deep: { n: 0 } } });
		const heard = new Array<string>();

		subscribe(state.a.deep, () => heard.push("deep"));
		subscribe(state.a, () => heard.push("a"));
		subscribe(state, () => heard.push("root"));

		transact(state.a.deep, () => {
			state.a.deep.n = 1;
		});

		expect([...heard].sort()).toEqual(["a", "deep", "root"]);
	});
});
