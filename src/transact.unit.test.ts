import { createMutableState } from "./createMutableState";
import { ignore } from "./ignore";
import { CyclicValueError } from "./ops/cloneValue";
import { diffObjects } from "./ops/diff";
import { type Operation } from "./ops/operation";
import { shapeOps } from "./ops/operationShape";
import { subscribe } from "./subscribe";
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

	it("keeps writes on a record claimed dirty and reports them bare", async () => {
		const state = createMutableState({ a: { n: 0 }, bare: 0 });
		const heard = new Array<unknown>();

		subscribe(state, (_ops, meta) => heard.push(meta));
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
		expect(state.bare).toBe(2);
		expect(heard).toEqual([]);

		await Promise.resolve();

		expect(heard).toEqual([undefined]);
		expect(state.bare).toBe(2);
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

	it("rolls back every claim without delivering when a multi-claim report hits a cycle", async () => {
		const clean = createMutableState({ n: 0 });
		const cyclic = createMutableState<{ box: { self?: object } }>({ box: {} });
		const heard = new Array<unknown>();

		subscribe(clean, (ops, meta) => heard.push({ side: "clean", ops: [...ops], meta }));
		subscribe(cyclic, (ops, meta) => heard.push({ side: "cyclic", ops: [...ops], meta }));

		expect(() =>
			transact(
				clean,
				() => {
					clean.n = 1;
					cyclic.box.self = cyclic.box;
				},
				{ tag: "lost" },
			),
		).toThrow(CyclicValueError);

		expect(clean.n).toBe(0);
		expect(cyclic.box.self).toBeUndefined();
		expect(heard).toEqual([]);

		await Promise.resolve();

		expect(heard).toEqual([]);
	});

	it("still bare-reports a dirty co-claim when a multi-claim report hits a cycle", async () => {
		const dirty = createMutableState({ n: 0 });
		const cyclic = createMutableState<{ box: { self?: object } }>({ box: {} });
		const heard = new Array<{ side: string; ops: Array<Operation>; meta: unknown }>();

		subscribe(dirty, (ops, meta) => heard.push({ side: "dirty", ops: [...ops], meta }));
		subscribe(cyclic, (ops, meta) => heard.push({ side: "cyclic", ops: [...ops], meta }));

		dirty.n = 1;

		expect(() =>
			transact(
				cyclic,
				() => {
					dirty.n = 2;
					cyclic.box.self = cyclic.box;
				},
				{ tag: "lost" },
			),
		).toThrow(CyclicValueError);

		expect(dirty.n).toBe(2);
		expect(cyclic.box.self).toBeUndefined();
		expect(heard).toEqual([]);

		await Promise.resolve();

		expect(heard.map((entry) => ({ side: entry.side, ops: shapeOps(entry.ops), meta: entry.meta }))).toEqual([
			{
				side: "dirty",
				ops: [
					{
						do: { verb: "assign", path: ["n"], value: 2 },
						undo: { verb: "assign", path: ["n"], value: 0 },
					},
				],
				meta: undefined,
			},
		]);
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

	it("leaves delivered writes standing when a listener throws CyclicValueError", () => {
		const state = createMutableState({ n: 0 });
		const cyclic: { self?: object } = {};

		cyclic.self = cyclic;

		subscribe(state, () => {
			// Cycle on the after side so assertAcyclic on the do-half throws CyclicValueError.
			diffObjects({ box: {} }, { box: cyclic });
		});

		expect(() =>
			transact(state, () => {
				state.n = 42;
			}),
		).toThrow(CyclicValueError);

		expect(state.n).toBe(42);
	});

	it("leaves delivered writes standing when a listener throws AggregateError containing CyclicValueError", () => {
		const state = createMutableState({ n: 0 });
		const cyclic: { self?: object } = {};

		cyclic.self = cyclic;

		subscribe(state, () => {
			try {
				diffObjects({ box: {} }, { box: cyclic });
			} catch (error) {
				throw new AggregateError([error], "listener aggregate");
			}
		});

		expect(() =>
			transact(state, () => {
				state.n = 42;
			}),
		).toThrow(AggregateError);

		expect(state.n).toBe(42);
	});

	it("rolls back a cycle formed in the transaction, emits nothing, and raises synchronously", () => {
		const state = createMutableState<{ box: { self?: object } }>({ box: {} });
		const heard = new Array<unknown>();

		subscribe(state, (_ops, meta) => heard.push(meta));

		expect(() =>
			transact(
				state,
				() => {
					state.box.self = state.box;
				},
				{ tag: "lost" },
			),
		).toThrow(CyclicValueError);

		expect(state.box.self).toBeUndefined();
		expect(heard).toEqual([]);
	});

	it("still bare-delivers a dirty co-claim after a cyclic abort", async () => {
		const dirty = createMutableState({ n: 0 });
		const cyclic = createMutableState<{ box: { self?: object } }>({ box: {} });
		const heard = new Array<{ side: string; ops: Array<Operation>; meta: unknown }>();

		subscribe(dirty, (ops, meta) => heard.push({ side: "dirty", ops: [...ops], meta }));
		subscribe(cyclic, (ops, meta) => heard.push({ side: "cyclic", ops: [...ops], meta }));

		dirty.n = 1;

		expect(() =>
			transact(
				cyclic,
				() => {
					dirty.n = 2;
					cyclic.box.self = cyclic.box;
				},
				{ tag: "lost" },
			),
		).toThrow(CyclicValueError);

		expect(dirty.n).toBe(2);
		expect(cyclic.box.self).toBeUndefined();
		expect(heard).toEqual([]);

		await Promise.resolve();

		expect(heard.map((entry) => ({ side: entry.side, ops: shapeOps(entry.ops), meta: entry.meta }))).toEqual([
			{
				side: "dirty",
				ops: [
					{
						do: { verb: "assign", path: ["n"], value: 2 },
						undo: { verb: "assign", path: ["n"], value: 0 },
					},
				],
				meta: undefined,
			},
		]);
	});

	it("never arms a dirty cyclic record and leaves its baseline acyclic", async () => {
		const scheduled = new Array<() => void>();
		// Transact a separate root so entry reportBareDiff does not settle this record's bare window.
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

		expect(() =>
			transact(other, () => {
				state.n = 2;
				state.box.self = state.box;
			}),
		).toThrow(CyclicValueError);

		expect(state.n).toBe(2);
		expect(state.box.self).toBe(state.box);

		// restoreDirtyLedgers clears pending so a missing exclude would re-arm via scheduleFlush.
		// Drain microtasks: release must not have called emitOn again.
		await Promise.resolve();
		await Promise.resolve();

		expect(scheduled.length).toBe(scheduledAfterBare);

		// Repair the cycle the dirty claim kept, then run the pre-existing window flush.
		// A poisoned (cyclic) lastReported would refuse this diff; an acyclic baseline succeeds.
		delete state.box.self;

		expect(() => {
			for (const flush of scheduled.splice(0)) flush();
		}).not.toThrow();

		expect(state.n).toBe(2);
		expect(heard).toHaveLength(1);
		expect(shapeOps(heard[0]!.ops)).toEqual([
			{
				do: { verb: "assign", path: ["n"], value: 2 },
				undo: { verb: "assign", path: ["n"], value: 0 },
			},
		]);
		expect(heard[0]!.meta).toBeUndefined();
	});

	it.each([
		{
			order: "unrollable first",
			write: (
				unrollable: { box: { n: number; self?: object } },
				rollableA: { n: number },
				rollableB: { n: number },
			): void => {
				unrollable.box.n = 99;
				rollableA.n = 1;
				rollableB.n = 1;
			},
		},
		{
			order: "rollable first",
			write: (
				unrollable: { box: { n: number; self?: object } },
				rollableA: { n: number },
				rollableB: { n: number },
			): void => {
				rollableA.n = 1;
				rollableB.n = 1;
				unrollable.box.n = 99;
			},
		},
	])("unwinds every rollable claim when one claim cannot roll back ($order)", ({ write }) => {
		const absorb = (_flush: () => void): void => undefined;
		const rollableA = createMutableState({ n: 0 }, { emitOn: absorb });
		const rollableB = createMutableState({ n: 0 }, { emitOn: absorb });
		const unrollable = createMutableState<{ box: { n: number; self?: object } }>(
			{ box: { n: 1 } },
			{ emitOn: absorb },
		);

		unrollable.box.self = unrollable.box;

		subscribe(rollableA, () => undefined);
		subscribe(rollableB, () => undefined);
		subscribe(unrollable, () => undefined);

		const callbackError = new Error("abort");

		expect(() =>
			transact(rollableA, () => {
				write(unrollable, rollableA, rollableB);

				throw callbackError;
			}),
		).toThrow(callbackError);

		expect(rollableA.n).toBe(0);
		expect(rollableB.n).toBe(0);
		expect(unrollable.box.n).toBe(99);
	});

	it("attaches a rollback failure as a non-enumerable cause on an Error with no cause", () => {
		const absorb = (_flush: () => void): void => undefined;
		const state = createMutableState<{ box: { n: number; self?: object } }>({ box: { n: 1 } }, { emitOn: absorb });

		state.box.self = state.box;

		subscribe(state, () => undefined);

		const callbackError = new Error("callback failed");
		let caught: unknown;

		try {
			transact(state, () => {
				state.box.n = 99;

				throw callbackError;
			});
		} catch (error) {
			caught = error;
		}

		expect(caught).toBe(callbackError);
		expect(callbackError.cause).toBeInstanceOf(CyclicValueError);
		expect(Object.getOwnPropertyDescriptor(callbackError, "cause")?.enumerable).toBe(false);
	});

	it("keeps an existing cause when rollback fails", () => {
		const absorb = (_flush: () => void): void => undefined;
		const state = createMutableState<{ box: { n: number; self?: object } }>({ box: { n: 1 } }, { emitOn: absorb });

		state.box.self = state.box;

		subscribe(state, () => undefined);

		const originalCause = new Error("root cause");
		const callbackError = new Error("wrapper", { cause: originalCause });
		let caught: unknown;

		try {
			transact(state, () => {
				state.box.n = 99;

				throw callbackError;
			});
		} catch (error) {
			caught = error;
		}

		expect(caught).toBe(callbackError);
		expect(callbackError.cause).toBe(originalCause);
	});

	it("rethrows a non-Error throw exactly and does not surface a rollback failure", () => {
		const absorb = (_flush: () => void): void => undefined;
		const state = createMutableState<{ box: { n: number; self?: object } }>({ box: { n: 1 } }, { emitOn: absorb });

		state.box.self = state.box;

		subscribe(state, () => undefined);

		const thrown = "primitive abort";
		let caught: unknown;

		try {
			transact(state, () => {
				state.box.n = 99;

				throw thrown;
			});
		} catch (error) {
			caught = error;
		}

		expect(caught).toBe(thrown);
	});
});
