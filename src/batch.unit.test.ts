import { createMutableState } from "./createMutableState";
import { isSameIdentity } from "./identity";
import { applyOperations } from "./ops/applyOperations";
import { type Operation } from "./ops/operation";
import { subscribe } from "./subscribe";
import { batch } from "./batch";

const captureUncaught = (run: () => void): Array<() => void> => {
	const released = new Array<() => void>();
	const originalQueueMicrotask = globalThis.queueMicrotask.bind(globalThis);

	globalThis.queueMicrotask = (callback: () => void) => {
		released.push(callback);
	};

	try {
		run();

		return released;
	} finally {
		globalThis.queueMicrotask = originalQueueMicrotask;
	}
};

describe("batch", () => {
	it("runs the callback synchronously", () => {
		const state = createMutableState({ n: 0 });
		let ran = false;

		batch(() => {
			ran = true;
			state.n = 1;
		});

		expect(ran).toBe(true);
		expect(state.n).toBe(1);
	});

	it("emits a pending ordinary Write without meta before the same state's first batch write delivers with meta", async () => {
		const state = createMutableState({ a: { n: 0 }, bare: 0 });
		const heard = new Array<{ paths: Array<Operation["do"]["path"]>; meta: unknown }>();

		subscribe(state, (ops, meta) => {
			heard.push({ paths: ops.map((operation) => operation.do.path), meta });
		});

		state.bare = 1;

		batch(() => {
			state.a.n = 1;
		}, "batch-meta");

		expect(heard).toEqual([
			{ paths: [["bare"]], meta: undefined },
			{ paths: [["a", "n"]], meta: "batch-meta" },
		]);

		await Promise.resolve();

		expect(heard).toHaveLength(2);
	});

	it("delivers multi-state writes as one drain with the meta on every emission", () => {
		const first = createMutableState({ n: 0 });
		const second = createMutableState({ n: 0 });
		const heard = new Array<{ state: string; meta: unknown }>();
		let draining = false;

		subscribe(first, (_ops, meta) => {
			draining = true;
			heard.push({ state: "first", meta });
		});
		subscribe(second, (_ops, meta) => {
			expect(draining).toBe(true);
			heard.push({ state: "second", meta });
		});

		batch(() => {
			first.n = 1;
			second.n = 2;
		}, "shared");

		expect(heard).toEqual([
			{ state: "first", meta: "shared" },
			{ state: "second", meta: "shared" },
		]);
	});

	it("emits a throwing callback's completed writes with the meta and rethrows after delivery", () => {
		const state = createMutableState({ a: 0, b: 0 });
		const heard = new Array<{ paths: Array<Operation["do"]["path"]>; meta: unknown }>();

		subscribe(state, (ops, meta) => {
			heard.push({ paths: ops.map((operation) => operation.do.path), meta });
		});

		expect(() => {
			batch(() => {
				state.a = 1;
				throw new Error("mutate failure");
			}, "thrown");
		}).toThrow("mutate failure");

		expect(state.a).toBe(1);
		expect(heard).toEqual([{ paths: [["a"]], meta: "thrown" }]);
	});

	it("delivers inner and outer writes with their own meta", () => {
		const outerState = createMutableState({ n: 0 });
		const innerState = createMutableState({ n: 0 });
		const heard = new Array<{ state: string; meta: unknown }>();

		subscribe(outerState, (_ops, meta) => heard.push({ state: "outer", meta }));
		subscribe(innerState, (_ops, meta) => heard.push({ state: "inner", meta }));

		batch(() => {
			outerState.n = 1;
			batch(() => {
				innerState.n = 2;
			}, "inner-meta");
		}, "outer-meta");

		expect(heard).toEqual([
			{ state: "inner", meta: "inner-meta" },
			{ state: "outer", meta: "outer-meta" },
		]);
	});

	it("emits an enclosing frame's window with its meta at an overlapping inner write", () => {
		const state = createMutableState({ a: 0, b: 0 });
		const heard = new Array<{ paths: Array<Operation["do"]["path"]>; meta: unknown }>();

		subscribe(state, (ops, meta) => {
			heard.push({ paths: ops.map((operation) => operation.do.path), meta });
		});

		batch(() => {
			state.a = 1;
			batch(() => {
				state.b = 2;
			}, "inner");
		}, "outer");

		expect(heard).toEqual([
			{ paths: [["a"]], meta: "outer" },
			{ paths: [["b"]], meta: "inner" },
		]);
	});

	it("delivers nothing when the callback writes nothing", () => {
		const state = createMutableState({ n: 0 });
		const heard = new Array<Array<Operation>>();

		subscribe(state, (ops) => heard.push([...ops]));

		batch(() => undefined, "unused");

		expect(heard).toEqual([]);
	});

	it("restores identity when a consumer applies the emitted undo halves in reverse", () => {
		const state = createMutableState({ child: { n: 1 }, flag: false });
		const held = state.child;
		const heard = new Array<Operation>();

		subscribe(state, (ops) => heard.push(...ops));

		batch(() => {
			state.flag = true;
			state.child = { n: 2 };
			state.child.n = 3;
		});

		expect(state.flag).toBe(true);
		expect(state.child.n).toBe(3);
		expect(isSameIdentity(state.child, held)).toBe(false);

		applyOperations(state, heard, "undo");

		expect(state.flag).toBe(false);
		expect(isSameIdentity(state.child, held)).toBe(true);
		expect(state.child.n).toBe(1);
	});

	it("a throwing subscriber does not fail batch and its failure surfaces from a queueMicrotask", () => {
		const state = createMutableState({ n: 0 });
		const failure = new Error("listener failed");

		subscribe(state, () => {
			throw failure;
		});

		const released = captureUncaught(() => {
			batch(() => {
				state.n = 1;
			});
		});

		expect(state.n).toBe(1);
		expect(released).toHaveLength(1);
		expect(() => released[0]?.()).toThrow(failure);
	});

	it("two throwing subscribers release one AggregateError", () => {
		const state = createMutableState({ n: 0 });
		const first = new Error("first failure");
		const second = new Error("second failure");

		subscribe(state, () => {
			throw first;
		});
		subscribe(state, () => {
			throw second;
		});

		const released = captureUncaught(() => {
			batch(() => {
				state.n = 1;
			});
		});

		expect(state.n).toBe(1);
		expect(released).toHaveLength(1);

		let thrown: unknown;

		try {
			released[0]?.();
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toBeInstanceOf(AggregateError);
		expect((thrown as AggregateError).message).toBe("opshot: listeners failed during delivery");
		expect((thrown as AggregateError).errors).toEqual([first, second]);
	});
});
