import { batch } from "./batch";
import { createMutableState } from "./createMutableState";
import type { Operation } from "./operation";
import { subscribe } from "./subscribe";

const listen = (state: object): Array<ReadonlyArray<Operation>> => {
	const heard: Array<ReadonlyArray<Operation>> = [];

	subscribe(state, (operations) => {
		heard.push(operations);
	});

	return heard;
};

describe("§3 an operation is node, key, before, after, meta", () => {
	it("covers assignment, deletion, addition, undefined stored versus absent, an object value as its proxy, and the node the user reads", async () => {
		const state = createMutableState({
			count: 0,
			extra: 1,
			child: { n: 1 },
		} as { count: number; extra?: number; child: { n: number }; stored?: undefined });
		const heard = listen(state);
		const previousChild = state.child;
		const nextChild = { n: 2 };

		state.count = 1;
		delete state.extra;
		state.stored = undefined;
		state.child = nextChild;

		await Promise.resolve();

		expect(heard).toHaveLength(1);

		const operations = heard[0] ?? [];
		const count = operations.find((operation) => operation.key === "count");
		const extra = operations.find((operation) => operation.key === "extra");
		const stored = operations.find((operation) => operation.key === "stored");
		const child = operations.find((operation) => operation.key === "child");

		expect(count?.node).toBe(state);
		expect(count).toMatchObject({ key: "count", before: 0, after: 1, meta: undefined });

		expect(extra?.node).toBe(state);
		expect(extra?.before).toBe(1);
		expect("after" in (extra ?? {})).toBe(false);
		expect(extra?.meta).toBeUndefined();

		expect(stored?.node).toBe(state);
		expect("before" in (stored ?? {})).toBe(false);
		expect("after" in (stored ?? {})).toBe(true);
		expect(stored?.after).toBeUndefined();

		expect(child?.node).toBe(state);
		expect(child?.before).toBe(previousChild);
		expect(child?.after).toBe(state.child);
		expect(child?.after).not.toBe(nextChild);
	});
});

describe("§3.1 operations whose metas differ are never collapsed", () => {
	it("two batch calls of different metas writing the same key stay two operations", async () => {
		const state = createMutableState({ n: 0 });
		const heard = listen(state);

		batch(() => {
			state.n = 1;
		}, "first");
		batch(() => {
			state.n = 2;
		}, "second");

		await Promise.resolve();

		expect(heard).toHaveLength(1);
		expect(heard[0]).toHaveLength(2);
		expect(heard[0]?.[0]).toMatchObject({ key: "n", before: 0, after: 1, meta: "first" });
		expect(heard[0]?.[1]).toMatchObject({ key: "n", before: 1, after: 2, meta: "second" });
	});

	it("a batch beside a bare write of the same key stays two operations", async () => {
		const state = createMutableState({ n: 0 });
		const heard = listen(state);

		batch(() => {
			state.n = 1;
		}, "tagged");
		state.n = 2;

		await Promise.resolve();

		expect(heard).toHaveLength(1);
		expect(heard[0]).toHaveLength(2);
		expect(heard[0]?.[0]).toMatchObject({ key: "n", before: 0, after: 1, meta: "tagged" });
		expect(heard[0]?.[1]).toMatchObject({ key: "n", before: 1, after: 2, meta: undefined });
	});
});

describe("§4.1 a write inside batch carries its meta", () => {
	it("tags writes, with nested batches taking the innermost meta", async () => {
		const state = createMutableState({ n: 0, m: 0 });
		const heard = listen(state);

		batch(() => {
			batch(() => {
				state.n = 1;
			}, "inner");
			state.m = 1;
		}, "outer");

		expect(heard).toEqual([]);

		await Promise.resolve();

		expect(heard[0]?.[0]).toMatchObject({ key: "n", after: 1, meta: "inner" });
		expect(heard[0]?.[1]).toMatchObject({ key: "m", after: 1, meta: "outer" });
	});

	it("writes before a throwing callback carry the meta and the throw propagates", async () => {
		const state = createMutableState({ n: 0 });
		const heard = listen(state);

		expect(() => {
			batch(() => {
				state.n = 1;
				throw new Error("boom");
			}, "tagged");
		}).toThrow("boom");

		expect(state.n).toBe(1);

		await Promise.resolve();

		expect(heard[0]?.[0]).toMatchObject({ key: "n", before: 0, after: 1, meta: "tagged" });
	});
});
