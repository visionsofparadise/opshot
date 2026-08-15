import { createMutableState } from "./createMutableState";
import { ignore } from "./ignore";
import { applyOperations } from "./ops/applyOperations";
import * as diffModule from "./ops/diff";
import { type Operation } from "./ops/operation";
import { shapeOps } from "./ops/operationShape";
import { subscribe } from "./subscribe";
import { TrackedMap } from "./tracked/trackedMap";
import { transact } from "./transact";

describe("transact", () => {
	it("runs the mutate callback and emits ops with meta when subscribed", () => {
		const state = createMutableState({ count: 0 });
		const heard = new Array<{ ops: Array<Operation>; meta: unknown }>();

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
		expect(heard.map((entry) => ({ ops: shapeOps(entry.ops), meta: entry.meta }))).toEqual([
			{
				ops: [
					{
						do: { verb: "assign", path: ["count"], value: 3 },
						undo: { verb: "assign", path: ["count"], value: 0 },
					},
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

	it("emits a covering ancestor's pending Writes before that ancestor's Transaction write", async () => {
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

		expect(heard).toEqual([undefined, { tag: "mine" }]);

		await Promise.resolve();

		transact(
			state.a,
			() => {
				state.a.n = 2;
			},
			{ tag: "mine" },
		);

		expect(heard).toEqual([undefined, { tag: "mine" }, { tag: "mine" }]);
	});

	it("rolls back a claimed node when mutate throws and emits nothing", async () => {
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
		expect(state.a.n).toBe(0);
		expect(heard).toEqual([]);

		await Promise.resolve();

		expect(heard).toEqual([]);
	});

	it("emits nothing when a rolled-back transaction had written", async () => {
		const state = createMutableState({ n: 0 });
		const heard = new Array<{ ops: Array<Operation>; meta: unknown }>();

		subscribe(state, (ops, meta) => heard.push({ ops: [...ops], meta }));

		expect(() =>
			transact(
				state,
				() => {
					state.n = 7;

					throw new Error("abort");
				},
				{ tag: "lost" },
			),
		).toThrow("abort");

		expect(state.n).toBe(0);
		expect(heard).toEqual([]);

		await Promise.resolve();

		expect(heard).toEqual([]);
	});

	it("restores a replaced object by identity when mutate throws", () => {
		const state = createMutableState({ child: { a: 1, b: 2, c: 3, d: 4, e: 5 } });
		const held = state.child;

		subscribe(state, () => undefined);

		expect(() =>
			transact(state, () => {
				state.child = { a: 9, b: 9, c: 9, d: 9, e: 9 };

				throw new Error("abort");
			}),
		).toThrow("abort");

		expect(state.child).toBe(held);
		expect(state.child).toEqual({ a: 1, b: 2, c: 3, d: 4, e: 5 });
	});

	it("rolls a dirty covering ancestor back to the frame-open snapshot and later emits the pending Write", async () => {
		const state = createMutableState({ a: { n: 0 }, bare: 0 });
		const heard = new Array<{ ops: Array<Operation>; meta: unknown }>();

		subscribe(state, (ops, meta) => heard.push({ ops: [...ops], meta }));
		subscribe(state.a, () => undefined);

		state.bare = 1;

		expect(() =>
			transact(
				state.a,
				() => {
					state.a.n = 1;
					state.bare = 2;

					throw new Error("abort");
				},
				{ tag: "mine" },
			),
		).toThrow("abort");

		expect(state.a.n).toBe(0);
		expect(state.bare).toBe(1);
		expect(heard).toEqual([]);

		await Promise.resolve();

		expect(heard.map((entry) => ({ ops: shapeOps(entry.ops), meta: entry.meta }))).toEqual([
			{
				ops: [
					{
						do: { verb: "assign", path: ["bare"], value: 1 },
						undo: { verb: "assign", path: ["bare"], value: 0 },
					},
				],
				meta: undefined,
			},
		]);
		expect(state.bare).toBe(1);
	});

	it("leaves an ignore()d mutation standing when mutate throws", () => {
		const bag = { x: 0 };
		const state = createMutableState({ n: 0, bag: ignore(bag) });

		subscribe(state, () => undefined);

		expect(() =>
			transact(state, () => {
				state.n = 1;
				state.bag.x = 99;

				throw new Error("abort");
			}),
		).toThrow("abort");

		expect(state.n).toBe(0);
		expect(state.bag.x).toBe(99);
		expect(bag.x).toBe(99);
	});

	it("delivers every claim when a multi-claim transaction forms a cycle", async () => {
		const clean = createMutableState({ n: 0 });
		const cyclic = createMutableState<{ box: { self?: object } }>({ box: {} });
		const heard = new Array<{ side: string; ops: Array<Operation>; meta: unknown }>();

		subscribe(clean, (ops, meta) => heard.push({ side: "clean", ops: [...ops], meta }));
		subscribe(cyclic, (ops, meta) => heard.push({ side: "cyclic", ops: [...ops], meta }));

		transact(
			clean,
			() => {
				clean.n = 1;
				cyclic.box.self = cyclic.box;
			},
			{ tag: "kept" },
		);

		expect(clean.n).toBe(1);
		expect(cyclic.box.self).toBe(cyclic.box);
		expect(heard.map((entry) => entry.side).sort()).toEqual(["clean", "cyclic"]);

		await Promise.resolve();

		expect(heard).toHaveLength(2);
	});

	it("emits a dirty co-claim's pending Write then its Transaction write when a sibling forms a cycle", async () => {
		const dirty = createMutableState({ n: 0 });
		const cyclic = createMutableState<{ box: { self?: object } }>({ box: {} });
		const heard = new Array<{ side: string; ops: Array<Operation>; meta: unknown }>();

		subscribe(dirty, (ops, meta) => heard.push({ side: "dirty", ops: [...ops], meta }));
		subscribe(cyclic, (ops, meta) => heard.push({ side: "cyclic", ops: [...ops], meta }));

		dirty.n = 1;

		transact(
			cyclic,
			() => {
				dirty.n = 2;
				cyclic.box.self = cyclic.box;
			},
			{ tag: "kept" },
		);

		expect(dirty.n).toBe(2);
		expect(cyclic.box.self).toBe(cyclic.box);

		await Promise.resolve();

		expect(
			heard
				.filter((entry) => entry.side === "dirty")
				.map((entry) => ({ ops: shapeOps(entry.ops), meta: entry.meta })),
		).toEqual([
			{
				ops: [{ do: { verb: "assign", path: ["n"], value: 1 }, undo: { verb: "assign", path: ["n"], value: 0 } }],
				meta: undefined,
			},
			{
				ops: [{ do: { verb: "assign", path: ["n"], value: 2 }, undo: { verb: "assign", path: ["n"], value: 1 } }],
				meta: { tag: "kept" },
			},
		]);
		expect(heard.filter((entry) => entry.side === "cyclic").map((entry) => entry.meta)).toEqual([{ tag: "kept" }]);
	});

	it("never flushes a claimed record bare when a listener transacts it", () => {
		const transacted = createMutableState({ x: 0 });
		const claimed = createMutableState({ n: 0 });
		const heard = new Array<{ ops: Array<Operation>; meta: unknown }>();
		let listenerTransactCompleted = false;

		subscribe(claimed, (ops, meta) => heard.push({ ops: [...ops], meta }));
		subscribe(transacted, () => {
			transact(
				claimed,
				() => {
					claimed.n += 10;
				},
				{ tag: "tap" },
			);
			listenerTransactCompleted = true;
		});

		transact(
			transacted,
			() => {
				transacted.x = 1;
				claimed.n = 5;
			},
			{ tag: "outer" },
		);

		expect(listenerTransactCompleted).toBe(true);
		expect(heard.map((entry) => ({ ops: shapeOps(entry.ops), meta: entry.meta }))).toEqual([
			{
				ops: [{ do: { verb: "assign", path: ["n"], value: 5 }, undo: { verb: "assign", path: ["n"], value: 0 } }],
				meta: { tag: "outer" },
			},
			{
				ops: [{ do: { verb: "assign", path: ["n"], value: 15 }, undo: { verb: "assign", path: ["n"], value: 5 } }],
				meta: { tag: "tap" },
			},
		]);
	});

	it("never files a replicator's write as a user edit when a listener transacts the claimed record", () => {
		const transacted = createMutableState({ x: 0 });
		const claimed = createMutableState({ n: 0 });
		const recorded = new Array<Operation>();
		let listenerTransactCompleted = false;

		subscribe(claimed, (ops, meta) => {
			if ((meta as { replay?: boolean } | undefined)?.replay === true) return;

			recorded.push(...ops);
		});
		subscribe(transacted, () => {
			transact(claimed, () => {
				claimed.n += 10;
			});
			listenerTransactCompleted = true;
		});

		transact(
			transacted,
			() => {
				transacted.x = 1;
				claimed.n = 5;
			},
			{ replay: true },
		);

		expect(listenerTransactCompleted).toBe(true);
		expect(shapeOps(recorded)).toEqual([
			{ do: { verb: "assign", path: ["n"], value: 15 }, undo: { verb: "assign", path: ["n"], value: 5 } },
		]);
	});

	it("carries meta on a cross-state write made inside the transaction", () => {
		const first = createMutableState({ x: 0 });
		const second = createMutableState({ n: 0 });
		const heard = new Array<{ ops: Array<Operation>; meta: unknown }>();

		subscribe(second, (ops, meta) => heard.push({ ops: [...ops], meta }));

		transact(
			first,
			() => {
				first.x = 1;
				second.n = 1;
			},
			{ tag: "outer" },
		);

		expect(heard.map((entry) => ({ ops: shapeOps(entry.ops), meta: entry.meta }))).toEqual([
			{
				ops: [{ do: { verb: "assign", path: ["n"], value: 1 }, undo: { verb: "assign", path: ["n"], value: 0 } }],
				meta: { tag: "outer" },
			},
		]);
	});

	it("emits nothing when the callback writes nothing", () => {
		const state = createMutableState({ n: 0 });
		const heard = new Array<unknown>();

		subscribe(state, (_ops, meta) => heard.push(meta));

		transact(state, () => undefined, { tag: "empty" });

		expect(heard).toEqual([]);
		expect(state.n).toBe(0);
	});

	it("never flushes a claimed record bare when a listener unsubscribes its listener", () => {
		const transacted = createMutableState({ x: 0 });
		const claimed = createMutableState({ n: 0 });
		const heard = new Array<unknown>();
		const stopClaimed = subscribe(claimed, (_ops, meta) => heard.push(meta));

		subscribe(transacted, () => stopClaimed());

		transact(
			transacted,
			() => {
				transacted.x = 1;
				claimed.n = 5;
			},
			{ tag: "outer" },
		);

		expect(heard).toEqual([{ tag: "outer" }]);
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

	it("leaves delivered writes standing when a listener throws", () => {
		const state = createMutableState({ n: 0 });

		subscribe(state, () => {
			throw new Error("listener failed");
		});

		expect(() =>
			transact(state, () => {
				state.n = 42;
			}),
		).toThrow("listener failed");

		expect(state.n).toBe(42);
	});

	it("leaves delivered writes standing when a listener throws AggregateError", () => {
		const state = createMutableState({ n: 0 });

		subscribe(state, () => {
			throw new AggregateError([new Error("inner")], "listener aggregate");
		});

		expect(() =>
			transact(state, () => {
				state.n = 42;
			}),
		).toThrow(AggregateError);

		expect(state.n).toBe(42);
	});

	it("delivers a cycle formed in the transaction without rolling back", () => {
		const state = createMutableState<{ box: { self?: object } }>({ box: {} });
		const heard = new Array<unknown>();

		subscribe(state, (_ops, meta) => heard.push(meta));

		transact(
			state,
			() => {
				state.box.self = state.box;
			},
			{ tag: "kept" },
		);

		expect(state.box.self).toBe(state.box);
		expect(heard).toEqual([{ tag: "kept" }]);
	});

	it("still bare-delivers a dirty co-claim after a cyclic formation in the same transaction", async () => {
		const dirty = createMutableState({ n: 0 });
		const cyclic = createMutableState<{ box: { self?: object } }>({ box: {} });
		const heard = new Array<{ side: string; ops: Array<Operation>; meta: unknown }>();

		subscribe(dirty, (ops, meta) => heard.push({ side: "dirty", ops: [...ops], meta }));
		subscribe(cyclic, (ops, meta) => heard.push({ side: "cyclic", ops: [...ops], meta }));

		dirty.n = 1;

		transact(
			cyclic,
			() => {
				dirty.n = 2;
				cyclic.box.self = cyclic.box;
			},
			{ tag: "kept" },
		);

		expect(dirty.n).toBe(2);
		expect(cyclic.box.self).toBe(cyclic.box);

		await Promise.resolve();

		expect(
			heard
				.filter((entry) => entry.side === "dirty")
				.map((entry) => ({ ops: shapeOps(entry.ops), meta: entry.meta })),
		).toEqual([
			{
				ops: [{ do: { verb: "assign", path: ["n"], value: 1 }, undo: { verb: "assign", path: ["n"], value: 0 } }],
				meta: undefined,
			},
			{
				ops: [{ do: { verb: "assign", path: ["n"], value: 2 }, undo: { verb: "assign", path: ["n"], value: 1 } }],
				meta: { tag: "kept" },
			},
		]);
		expect(heard.filter((entry) => entry.side === "cyclic").map((entry) => entry.meta)).toEqual([{ tag: "kept" }]);
	});

	it("delivers through a dirty record that already holds a cycle", async () => {
		const scheduled = new Array<() => void>();
		const other = createMutableState({ x: 0 });
		const state = createMutableState<{ n: number; box: { self?: object } }>(
			{ n: 0, box: {} },
			{
				emitOn: (flush) => {
					scheduled.push(flush);
				},
			},
		);
		const heard = new Array<{ ops: Array<Operation>; meta: unknown }>();

		subscribe(state, (ops, meta) => heard.push({ ops: [...ops], meta }));

		state.n = 1;

		await Promise.resolve();

		const scheduledAfterBare = scheduled.length;

		expect(scheduledAfterBare).toBe(1);

		transact(other, () => {
			state.n = 2;
			state.box.self = state.box;
		});

		expect(state.n).toBe(2);
		expect(state.box.self).toBe(state.box);
		expect(heard.map((entry) => ({ ops: shapeOps(entry.ops), meta: entry.meta }))).toEqual([
			{
				ops: [{ do: { verb: "assign", path: ["n"], value: 1 }, undo: { verb: "assign", path: ["n"], value: 0 } }],
				meta: undefined,
			},
			{
				ops: [
					{ do: { verb: "assign", path: ["n"], value: 2 }, undo: { verb: "assign", path: ["n"], value: 1 } },
					{
						do: { verb: "link", path: ["box", "self"], ref: ["box"] },
						undo: { verb: "delete", path: ["box", "self"] },
					},
				],
				meta: undefined,
			},
		]);

		expect(() => {
			for (const flush of scheduled.splice(0)) flush();
		}).not.toThrow();

		expect(state.n).toBe(2);
		expect(heard).toHaveLength(2);
	});

	it.each([
		{
			order: "first claim first",
			write: (first: { n: number }, second: { n: number }, third: { n: number }): void => {
				first.n = 99;
				second.n = 1;
				third.n = 1;
			},
		},
		{
			order: "rollable first",
			write: (first: { n: number }, second: { n: number }, third: { n: number }): void => {
				second.n = 1;
				third.n = 1;
				first.n = 99;
			},
		},
	])("unwinds every rollable claim when the callback aborts ($order)", ({ write }) => {
		const absorb = (_flush: () => void): void => undefined;
		const rollableA = createMutableState({ n: 0 }, { emitOn: absorb });
		const rollableB = createMutableState({ n: 0 }, { emitOn: absorb });
		const alsoRollable = createMutableState({ n: 0 }, { emitOn: absorb });

		subscribe(rollableA, () => undefined);
		subscribe(rollableB, () => undefined);
		subscribe(alsoRollable, () => undefined);

		const callbackError = new Error("abort");

		expect(() =>
			transact(rollableA, () => {
				write(alsoRollable, rollableA, rollableB);

				throw callbackError;
			}),
		).toThrow(callbackError);

		expect(rollableA.n).toBe(0);
		expect(rollableB.n).toBe(0);
		expect(alsoRollable.n).toBe(0);
	});

	it("attaches a prepare failure as a non-enumerable cause when rollback also fails", () => {
		const absorb = (_flush: () => void): void => undefined;
		const state = createMutableState({ n: 0 }, { emitOn: absorb });

		subscribe(state, () => undefined);

		const prepareError = new Error("prepare failed");
		const rollbackError = new Error("rollback failed");
		let diffCalls = 0;
		const spy = vi.spyOn(diffModule, "diffObjects").mockImplementation(() => {
			diffCalls += 1;

			throw diffCalls === 1 ? prepareError : rollbackError;
		});

		let caught: unknown;

		try {
			transact(state, () => {
				state.n = 1;
			});
		} catch (error) {
			caught = error;
		} finally {
			spy.mockRestore();
		}

		expect(caught).toBe(prepareError);
		expect(prepareError.cause).toBe(rollbackError);
		expect(Object.getOwnPropertyDescriptor(prepareError, "cause")?.enumerable).toBe(false);
	});

	it("attaches a rollback failure as a non-enumerable cause on a callback Error with no cause", () => {
		const absorb = (_flush: () => void): void => undefined;
		const state = createMutableState({ n: 0 }, { emitOn: absorb });

		subscribe(state, () => undefined);

		const callbackError = new Error("callback failed");
		const rollbackError = new Error("rollback failed");
		const spy = vi.spyOn(diffModule, "diffObjects").mockImplementation(() => {
			throw rollbackError;
		});

		let caught: unknown;

		try {
			transact(state, () => {
				state.n = 99;

				throw callbackError;
			});
		} catch (error) {
			caught = error;
		} finally {
			spy.mockRestore();
		}

		expect(caught).toBe(callbackError);
		expect(callbackError.cause).toBe(rollbackError);
		expect(Object.getOwnPropertyDescriptor(callbackError, "cause")?.enumerable).toBe(false);
	});

	it("keeps an existing cause when rollback fails", () => {
		const absorb = (_flush: () => void): void => undefined;
		const state = createMutableState({ n: 0 }, { emitOn: absorb });

		subscribe(state, () => undefined);

		const originalCause = new Error("root cause");
		const callbackError = new Error("wrapper", { cause: originalCause });
		const spy = vi.spyOn(diffModule, "diffObjects").mockImplementation(() => {
			throw new Error("rollback failed");
		});

		let caught: unknown;

		try {
			transact(state, () => {
				state.n = 99;

				throw callbackError;
			});
		} catch (error) {
			caught = error;
		} finally {
			spy.mockRestore();
		}

		expect(caught).toBe(callbackError);
		expect(callbackError.cause).toBe(originalCause);
	});

	it("rethrows a non-Error throw exactly and does not surface a rollback failure", () => {
		const absorb = (_flush: () => void): void => undefined;
		const state = createMutableState({ n: 0 }, { emitOn: absorb });

		subscribe(state, () => undefined);

		const thrown = "primitive abort";
		const spy = vi.spyOn(diffModule, "diffObjects").mockImplementation(() => {
			throw new Error("rollback failed");
		});

		let caught: unknown;

		try {
			transact(state, () => {
				state.n = 99;

				throw thrown;
			});
		} catch (error) {
			caught = error;
		} finally {
			spy.mockRestore();
		}

		expect(caught).toBe(thrown);
	});

	it("shares one proxy across two states and makes a write through either visible through both", () => {
		const shared: { n: number } = { n: 1 };
		const stateA = createMutableState({ map: new TrackedMap<string, { n: number }>() });
		const stateB = createMutableState({ map: new TrackedMap<string, { n: number }>() });

		transact(stateA, () => {
			stateA.map.set("k", shared);
		});
		transact(stateB, () => {
			stateB.map.set("k", shared);
		});

		expect(stateA.map.get("k")).toBe(stateB.map.get("k"));

		transact(stateA, () => {
			const held = stateA.map.get("k");

			if (held) held.n = 5;
		});

		expect(stateB.map.get("k")?.n).toBe(5);

		transact(stateB, () => {
			const held = stateB.map.get("k");

			if (held) held.n = 9;
		});

		expect(stateA.map.get("k")?.n).toBe(9);
	});

	it("delivers a shared write per-route in both states' streams", () => {
		const shared: { n: number } = { n: 1 };
		const stateA = createMutableState({ map: new TrackedMap<string, { n: number }>() });
		const stateB = createMutableState({ map: new TrackedMap<string, { n: number }>() });
		const heardA = new Array<{ ops: Array<Operation>; meta: unknown }>();
		const heardB = new Array<{ ops: Array<Operation>; meta: unknown }>();

		subscribe(stateA, (ops, meta) => heardA.push({ ops: [...ops], meta }));
		subscribe(stateB, (ops, meta) => heardB.push({ ops: [...ops], meta }));

		transact(stateA, () => {
			stateA.map.set("k", shared);
		});
		transact(stateB, () => {
			stateB.map.set("k", shared);
		});

		heardA.length = 0;
		heardB.length = 0;

		transact(
			stateA,
			() => {
				const held = stateA.map.get("k");

				if (held) held.n = 5;
			},
			{ tag: "shared" },
		);

		const expected = [
			{
				ops: [
					{
						do: { verb: "assign", path: ["map", "slots", 0, 1, "n"], value: 5 },
						undo: { verb: "assign", path: ["map", "slots", 0, 1, "n"], value: 1 },
					},
				],
				meta: { tag: "shared" },
			},
		];

		expect(heardA.map((entry) => ({ ops: shapeOps(entry.ops), meta: entry.meta }))).toEqual(expected);
		expect(heardB.map((entry) => ({ ops: shapeOps(entry.ops), meta: entry.meta }))).toEqual(expected);
		expect(stateB.map.get("k")?.n).toBe(5);
	});

	it("mints a link-undo removal in one state that ignores the other graph's routes and applies onto that state's replica alone", () => {
		const shared = { n: 1 };
		const stateA = createMutableState<{ a: { b: { n: number } }; b?: { n: number } }>({
			a: { b: shared },
			b: shared,
		});
		const stateB = createMutableState({ held: shared });
		const heardA = new Array<Array<Operation>>();

		subscribe(stateA, (ops) => heardA.push([...ops]));
		subscribe(stateB, () => undefined);

		transact(stateA, () => {
			delete stateA.b;
		});

		expect(shapeOps(heardA[0] ?? [])).toEqual([
			{
				do: { verb: "delete", path: ["b"] },
				undo: { verb: "link", path: ["b"], ref: ["a", "b"] },
			},
		]);
		expect(stateA.b).toBeUndefined();
		expect(stateA.a.b.n).toBe(1);
		expect(stateB.held.n).toBe(1);

		const replicaShared = { n: 1 };
		const replica = createMutableState<{ a: { b: { n: number } }; b?: { n: number } }>({
			a: { b: replicaShared },
			b: replicaShared,
		});

		expect(() => applyOperations(replica, heardA[0] ?? [], "do")).not.toThrow();
		expect(replica.b).toBeUndefined();
		expect(replica.a.b.n).toBe(1);
	});

	it("lets a clean subscribed sibling sharing a region observe nothing across a rolled-back transaction", async () => {
		const shared = { n: 1 };
		const stateA = createMutableState({ box: shared });
		const stateB = createMutableState({ box: shared });
		const heardA = new Array<{ ops: Array<Operation>; meta: unknown }>();
		const heardB = new Array<{ ops: Array<Operation>; meta: unknown }>();

		subscribe(stateA, (ops, meta) => heardA.push({ ops: [...ops], meta }));
		subscribe(stateB, (ops, meta) => heardB.push({ ops: [...ops], meta }));

		expect(() =>
			transact(
				stateA,
				() => {
					stateA.box.n = 9;

					throw new Error("abort");
				},
				{ tag: "lost" },
			),
		).toThrow("abort");

		expect(stateA.box.n).toBe(1);
		expect(stateB.box.n).toBe(1);
		expect(heardA).toEqual([]);
		expect(heardB).toEqual([]);

		await Promise.resolve();

		expect(heardA).toEqual([]);
		expect(heardB).toEqual([]);
	});

	it("rolls a dirty sibling back to the frame-open snapshot and later emits its pending Write", async () => {
		const shared = { n: 1 };
		const stateA = createMutableState({ box: shared });
		const stateB = createMutableState({ box: shared, bare: 0 });
		const heardA = new Array<{ ops: Array<Operation>; meta: unknown }>();
		const heardB = new Array<{ ops: Array<Operation>; meta: unknown }>();

		subscribe(stateA, (ops, meta) => heardA.push({ ops: [...ops], meta }));
		subscribe(stateB, (ops, meta) => heardB.push({ ops: [...ops], meta }));

		stateB.bare = 1;

		expect(() =>
			transact(
				stateA,
				() => {
					stateA.box.n = 9;
					stateB.bare = 2;

					throw new Error("abort");
				},
				{ tag: "lost" },
			),
		).toThrow("abort");

		expect(stateA.box.n).toBe(1);
		expect(stateB.box.n).toBe(1);
		expect(stateB.bare).toBe(1);
		expect(heardA).toEqual([]);
		expect(heardB).toEqual([]);

		await Promise.resolve();

		expect(heardA).toEqual([]);
		expect(heardB.map((entry) => ({ ops: shapeOps(entry.ops), meta: entry.meta }))).toEqual([
			{
				ops: [
					{
						do: { verb: "assign", path: ["bare"], value: 1 },
						undo: { verb: "assign", path: ["bare"], value: 0 },
					},
				],
				meta: undefined,
			},
		]);
	});

	it("leaves an uninvolved dirty window on its emitOn when another state transacts", async () => {
		const scheduled = new Array<() => void>();
		const uninvolved = createMutableState(
			{ n: 0 },
			{
				emitOn: (flush) => {
					scheduled.push(flush);
				},
			},
		);
		const other = createMutableState({ n: 0 });
		const heard = new Array<{ ops: Array<Operation>; meta: unknown }>();

		subscribe(uninvolved, (ops, meta) => heard.push({ ops: [...ops], meta }));
		subscribe(other, () => undefined);

		uninvolved.n = 1;

		await Promise.resolve();

		expect(scheduled).toHaveLength(1);

		transact(
			other,
			() => {
				other.n = 1;
			},
			{ tag: "a" },
		);

		expect(heard).toEqual([]);
		expect(scheduled).toHaveLength(1);

		scheduled[0]?.();

		expect(heard.map((entry) => ({ ops: shapeOps(entry.ops), meta: entry.meta }))).toEqual([
			{
				ops: [{ do: { verb: "assign", path: ["n"], value: 1 }, undo: { verb: "assign", path: ["n"], value: 0 } }],
				meta: undefined,
			},
		]);
	});
});
