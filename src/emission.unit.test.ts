import { batch } from "./batch";
import { createMutableState } from "./createMutableState";
import { flush } from "./flush";
import type { Operation } from "./operation";
import { subscribe } from "./subscribe";

const listen = (state: object): Array<ReadonlyArray<Operation>> => {
	const heard: Array<ReadonlyArray<Operation>> = [];

	subscribe(state, (operations) => {
		heard.push(operations);
	});

	return heard;
};

describe("§5.1 every change to a tracked node reaches subscribers", () => {
	it("a deep write reaches subscribers", async () => {
		const state = createMutableState({ child: { n: 1 } });
		const heard = listen(state);

		state.child.n = 2;

		await Promise.resolve();

		expect(heard).toHaveLength(1);
		expect(heard[0]?.[0]?.node).toBe(state.child);
		expect(heard[0]?.[0]).toMatchObject({ key: "n", before: 1, after: 2 });
	});

	it("an array push reaches subscribers", async () => {
		const state = createMutableState({ items: [] as Array<string> });
		const heard = listen(state);

		state.items.push("a");

		await Promise.resolve();

		expect(heard[0]?.map((operation) => operation.key)).toEqual(["0", "length"]);
		expect(heard[0]?.[0]).toMatchObject({ key: "0", after: "a" });
		expect("before" in (heard[0]?.[0] ?? {})).toBe(false);
		expect(heard[0]?.[1]).toMatchObject({ key: "length", before: 0, after: 1 });
		expect(heard[0]?.[0]?.node).toBe(state.items);
	});

	it("an array splice reaches subscribers", async () => {
		const state = createMutableState({ items: ["a", "b", "c"] });
		const heard = listen(state);

		state.items.splice(1, 2, "z");

		await Promise.resolve();

		expect(heard[0]?.map((operation) => operation.key)).toEqual(["2", "1", "length"]);
		expect("after" in (heard[0]?.[0] ?? {})).toBe(false);
		expect(heard[0]?.[0]?.before).toBe("c");
		expect(heard[0]?.[1]).toMatchObject({ key: "1", before: "b", after: "z" });
		expect(heard[0]?.[2]).toMatchObject({ key: "length", before: 3, after: 2 });
	});

	it("length truncation records one operation per discarded index", async () => {
		const state = createMutableState({ items: ["a", "b", "c"] });
		const heard = listen(state);

		state.items.length = 1;

		await Promise.resolve();

		expect(heard[0]).toHaveLength(3);
		expect(heard[0]?.[0]?.key).toBe("1");
		expect(heard[0]?.[0]?.before).toBe("b");
		expect("after" in (heard[0]?.[0] ?? {})).toBe(false);
		expect(heard[0]?.[1]?.key).toBe("2");
		expect(heard[0]?.[1]?.before).toBe("c");
		expect("after" in (heard[0]?.[1] ?? {})).toBe(false);
		expect(heard[0]?.[2]).toMatchObject({ key: "length", before: 3, after: 1 });
	});

	it("a listener throw reaches the caller after siblings run", async () => {
		let thrown: unknown;
		const state = createMutableState(
			{ n: 0 },
			{
				emitOn: (flush) => {
					try {
						flush();
					} catch (error) {
						thrown = error;
					}
				},
			},
		);
		const called: Array<string> = [];
		const failure = new Error("listener failure");

		subscribe(state, () => {
			called.push("first");
		});
		subscribe(state, () => {
			called.push("second");
			throw failure;
		});
		subscribe(state, () => {
			called.push("third");
		});

		state.n = 1;

		await Promise.resolve();

		expect(called).toEqual(["first", "second", "third"]);
		expect(thrown).toBe(failure);
	});

	it("several throwing subscribers rethrow as one AggregateError", async () => {
		let thrown: unknown;
		const state = createMutableState(
			{ n: 0 },
			{
				emitOn: (flush) => {
					try {
						flush();
					} catch (error) {
						thrown = error;
					}
				},
			},
		);
		const first = new Error("first failure");
		const second = new Error("second failure");

		subscribe(state, () => {
			throw first;
		});
		subscribe(state, () => {
			throw second;
		});

		state.n = 1;

		await Promise.resolve();

		expect(thrown).toBeInstanceOf(AggregateError);
		expect((thrown as AggregateError).message).toBe("opshot: listeners failed during delivery");
		expect((thrown as AggregateError).errors).toEqual([first, second]);
	});
});

describe("§5.2 an emission carries the net change", () => {
	it("a key written twice under one meta folds to one operation from the first before to the last after", async () => {
		const state = createMutableState({ n: 0 });
		const heard = listen(state);

		state.n = 1;
		state.n = 2;

		await Promise.resolve();

		expect(heard).toHaveLength(1);
		expect(heard[0]).toHaveLength(1);
		expect(heard[0]?.[0]).toMatchObject({ key: "n", before: 0, after: 2 });
	});

	it("a key returned to its value emits nothing", async () => {
		const state = createMutableState({ n: 0 });
		const heard = listen(state);

		state.n = 1;
		state.n = 0;

		await Promise.resolve();

		expect(heard).toEqual([]);
	});

	it("a window with nothing net emits nothing", async () => {
		const state = createMutableState({ n: 0 });
		const heard = listen(state);

		await Promise.resolve();

		expect(heard).toEqual([]);
	});
});

describe("§5.3 emitOn sets the window", () => {
	it("the microtask default delivers on the next microtask", async () => {
		const state = createMutableState({ n: 0 });
		const heard = listen(state);

		state.n = 1;

		expect(heard).toEqual([]);

		await Promise.resolve();

		expect(heard).toHaveLength(1);
		expect(heard[0]?.[0]).toMatchObject({ key: "n", after: 1 });
	});

	it("a requestAnimationFrame-style scheduler delivers only when it flushes", async () => {
		const scheduled: Array<() => void> = [];
		const state = createMutableState({ n: 0 }, { emitOn: (flush) => scheduled.push(flush) });
		const heard = listen(state);

		state.n = 1;
		state.n = 2;

		expect(scheduled).toEqual([]);
		expect(heard).toEqual([]);

		await Promise.resolve();

		expect(scheduled).toHaveLength(1);
		expect(heard).toEqual([]);

		scheduled[0]?.();

		expect(heard).toHaveLength(1);
		expect(heard[0]?.[0]).toMatchObject({ key: "n", before: 0, after: 2 });
	});
});

describe("flush ends the window", () => {
	it("two writes then a flush deliver one emission before any await", () => {
		const state = createMutableState({ n: 0 });
		const heard = listen(state);

		state.n = 1;
		state.n = 2;

		flush(state);

		expect(heard).toHaveLength(1);
		expect(heard[0]).toHaveLength(1);
		expect(heard[0]?.[0]).toMatchObject({ key: "n", before: 0, after: 2 });
	});

	it("a flush with nothing pending delivers nothing", async () => {
		const state = createMutableState({ n: 0 });
		const heard = listen(state);

		flush(state);

		expect(heard).toEqual([]);

		await Promise.resolve();

		expect(heard).toEqual([]);
	});

	it("a flush leaves a scheduler with no run, and a later write schedules one", async () => {
		const scheduled: Array<() => void> = [];
		const state = createMutableState({ n: 0 }, { emitOn: (run) => scheduled.push(run) });
		const heard = listen(state);

		state.n = 1;

		flush(state);

		expect(heard).toHaveLength(1);
		expect(heard[0]?.[0]).toMatchObject({ key: "n", before: 0, after: 1 });

		await Promise.resolve();

		expect(scheduled).toEqual([]);

		state.n = 2;

		await Promise.resolve();

		expect(scheduled).toHaveLength(1);

		scheduled[0]?.();

		expect(heard).toHaveLength(2);
		expect(heard[1]).toHaveLength(1);
		expect(heard[1]?.[0]).toMatchObject({ key: "n", before: 1, after: 2 });
	});

	it("a run a scheduler already holds delivers nothing after a flush", async () => {
		const scheduled: Array<() => void> = [];
		const state = createMutableState({ n: 0 }, { emitOn: (run) => scheduled.push(run) });
		const heard = listen(state);

		state.n = 1;

		await Promise.resolve();

		expect(scheduled).toHaveLength(1);

		flush(state);

		expect(heard).toHaveLength(1);

		scheduled[0]?.();

		expect(heard).toHaveLength(1);
	});

	it("a run a scheduler held before a flush delivers nothing, and the run scheduled after it delivers", async () => {
		const scheduled: Array<() => void> = [];
		const state = createMutableState({ n: 0 }, { emitOn: (run) => scheduled.push(run) });
		const heard = listen(state);

		state.n = 1;

		await Promise.resolve();

		flush(state);

		state.n = 2;

		await Promise.resolve();

		expect(scheduled).toHaveLength(2);

		scheduled[0]?.();

		expect(heard).toHaveLength(1);

		scheduled[1]?.();

		expect(heard).toHaveLength(2);
		expect(heard[1]?.[0]).toMatchObject({ key: "n", before: 1, after: 2 });
	});

	it("a flush inside a batch carries that batch's meta", () => {
		const state = createMutableState({ n: 0 });
		const heard = listen(state);
		const meta = { source: "flush" };

		batch(() => {
			state.n = 1;

			flush(state);
		}, meta);

		expect(heard).toHaveLength(1);
		expect(heard[0]?.[0]).toMatchObject({ key: "n", before: 0, after: 1 });
		expect(heard[0]?.[0]?.meta).toBe(meta);
	});

	it("a flush of a plain object throws", () => {
		expect(() => flush({})).toThrow("opshot: flush requires a state");
	});
});
