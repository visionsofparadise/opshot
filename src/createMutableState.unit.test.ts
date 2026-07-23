import { createGroup } from "./createGroup";
import { createMutableState } from "./createMutableState";
import { isSameIdentity } from "./identity";
import { isState } from "./isState";
import { ignore } from "./ignore";
import { diffSnapshots } from "./ops/diff";
import { type Op } from "./ops/operation";
import { subscribe } from "./subscribe";
import { transact } from "./transact";

vi.mock(import("./ops/diff"), { spy: true });

interface Counter {
	count: number;
	increment: () => void;
}

const createCounter = (): Counter =>
	createMutableState<Counter>({
		count: 0,
		increment() {
			this.count += 1;
		},
	});

const recordEmissions = (state: object): Array<{ ops: Array<Op>; meta: unknown }> => {
	const emissions = new Array<{ ops: Array<Op>; meta: unknown }>();

	subscribe(state, (ops, meta) => {
		emissions.push({ ops: [...ops], meta });
	});

	return emissions;
};

describe("createMutableState", () => {
	it("returns a live object that reflects writes immediately", () => {
		const state = createCounter();

		state.count = 9;

		expect(state.count).toBe(9);
		expect(isState(state)).toBe(true);
	});

	it("has no op or mutate keys and stringifies cleanly", () => {
		const state = createCounter();

		expect(Object.keys(state)).toEqual(["count", "increment"]);
		expect(JSON.stringify(state)).toBe('{"count":0}');
		expect("op" in state).toBe(false);
		expect("mutate" in state).toBe(false);
	});

	it("emits once per transact with the caller's meta verbatim", () => {
		const state = createCounter();
		const emissions = recordEmissions(state);

		transact(state, () => {
			state.count = 1;
		}, { transactionKey: "drag", replay: true });

		expect(emissions).toHaveLength(1);
		expect(emissions[0]?.ops).toEqual([
			{ do: { op: "replace", path: ["count"], value: 1 }, undo: { op: "replace", path: ["count"], value: 0 } },
		]);
		expect(emissions[0]?.meta).toEqual({ transactionKey: "drag", replay: true });

		transact(state, () => {
			state.count = 2;
		});

		expect(emissions).toHaveLength(2);
		expect(emissions[1]?.meta).toBeUndefined();
	});

	it("skips the diff while nothing listens, and resumes when a listener arrives", () => {
		const state = createMutableState({ count: 0 });

		vi.mocked(diffSnapshots).mockClear();

		transact(state, () => {
			state.count = 1;
		});

		expect(diffSnapshots).not.toHaveBeenCalled();
		expect(state.count).toBe(1);

		const heard = new Array<Array<Op>>();
		const unsubscribe = subscribe(state, (ops) => heard.push([...ops]));

		transact(state, () => {
			state.count = 2;
		});

		expect(diffSnapshots).toHaveBeenCalledTimes(1);
		expect(heard).toEqual([
			[{ do: { op: "replace", path: ["count"], value: 2 }, undo: { op: "replace", path: ["count"], value: 1 } }],
		]);

		unsubscribe();

		transact(state, () => {
			state.count = 3;
		});

		expect(diffSnapshots).toHaveBeenCalledTimes(1);
		expect(heard).toHaveLength(1);
		expect(state.count).toBe(3);
	});

	it("emits nothing for an empty mutation or a net-zero mutation", () => {
		const state = createCounter();
		const emissions = recordEmissions(state);

		transact(state, () => undefined);
		transact(state, () => {
			state.count = 0;
		});
		transact(state, () => {
			state.count = 1;
			state.count = 0;
		});

		expect(emissions).toHaveLength(0);
	});

	it("throws on nested transact of the same state and recovers after a throw", () => {
		const state = createCounter();

		subscribe(state, () => undefined);

		expect(() =>
			transact(state, () => {
				state.count = 1;
				transact(state, () => {
					state.count = 2;
				});
			}),
		).toThrow("opshot: nested transact on the same state");

		expect(state.count).toBe(1);

		expect(() =>
			transact(state, () => {
				throw new Error("boom");
			}),
		).toThrow("boom");

		state.increment();
		expect(state.count).toBe(2);
	});

	it("lets a transact of a second state run inside a callback and emit independently", () => {
		const first = createCounter();
		const second = createCounter();
		const firstEmissions = recordEmissions(first);
		const secondEmissions = recordEmissions(second);

		transact(first, () => {
			first.count = 1;
			transact(second, () => {
				second.count = 7;
			});
		});

		expect(firstEmissions).toHaveLength(1);
		expect(secondEmissions).toHaveLength(1);
		expect(second.count).toBe(7);
	});

	it("stops calling a listener after its remover runs", () => {
		const state = createCounter();
		const emissions = new Array<Array<Op>>();
		const remove = subscribe(state, (ops) => {
			emissions.push([...ops]);
		});

		remove();
		state.increment();

		expect(emissions).toHaveLength(0);
	});

	it("keeps domain methods working on the live object", () => {
		const state = createCounter();

		state.increment();
		state.increment();

		expect(state.count).toBe(2);
	});

	it("carries an ignore() field through without producing ops for its internals", () => {
		interface Log {
			index: number;
			readonly entries: Array<string>;
			append: (entry: string) => void;
		}

		const state = createMutableState<Log>({
			index: 0,
			entries: ignore(new Array<string>()),
			append(entry) {
				this.entries.push(entry);
				this.index += 1;
			},
		});
		const emissions = recordEmissions(state);

		transact(state, () => {
			state.append("one");
		});

		expect(state.entries).toEqual(["one"]);
		expect(emissions).toHaveLength(1);
		expect(emissions[0]?.ops).toEqual([
			{ do: { op: "replace", path: ["index"], value: 1 }, undo: { op: "replace", path: ["index"], value: 0 } },
		]);
	});

	it("keeps a retained input object out of the state", () => {
		const literal = { count: 0 };
		const state = createMutableState(literal);

		literal.count = 9;

		expect(state.count).toBe(0);
		expect(state).not.toBe(literal);
	});

	it("accepts the same plain object twice and yields independent states", () => {
		const defaults = { count: 0 };
		const first = createMutableState(defaults);
		const second = createMutableState(defaults);

		expect(isSameIdentity(first, second)).toBe(false);

		first.count = 5;

		expect(first.count).toBe(5);
		expect(second.count).toBe(0);
		expect(defaults.count).toBe(0);
	});

	it("preserves getters on the live object", () => {
		const state = createMutableState({
			count: 0,
			get doubled() {
				return this.count * 2;
			},
		});
		const emissions = recordEmissions(state);

		transact(state, () => {
			state.count = 1;
		});

		expect(emissions[0]?.ops).toEqual([
			{ do: { op: "replace", path: ["count"], value: 1 }, undo: { op: "replace", path: ["count"], value: 0 } },
		]);
		expect(state.doubled).toBe(2);
	});

	it("reports a bare write as ops on the microtask flush", async () => {
		const state = createMutableState({ count: 0 });
		const heard = new Array<{ ops: Array<Op>; meta: unknown }>();

		subscribe(state, (ops, meta) => {
			heard.push({ ops: [...ops], meta });
		});

		state.count = 5;

		expect(heard).toHaveLength(0);

		await Promise.resolve();

		expect(heard).toEqual([
			{
				ops: [{ do: { op: "replace", path: ["count"], value: 5 }, undo: { op: "replace", path: ["count"], value: 0 } }],
				meta: undefined,
			},
		]);
		expect(state.count).toBe(5);
	});

	it("emits exactly once for a transact, with no bare-flush echo", async () => {
		const state = createMutableState({ count: 0 });
		const heard = new Array<unknown>();

		subscribe(state, (_ops, meta) => {
			heard.push(meta);
		});

		transact(state, () => {
			state.count = 1;
		}, {});

		expect(heard).toHaveLength(1);
		expect(heard[0]).toEqual({});

		await Promise.resolve();

		expect(heard).toHaveLength(1);
	});

	it("orders a pending bare write before a subsequent transact in the same tick", async () => {
		const state = createMutableState({ count: 0, flag: false });
		const heard = new Array<{ path: unknown; meta: unknown }>();

		subscribe(state, (ops, meta) => {
			heard.push({ path: ops[0]?.do.path[0], meta });
		});

		state.count = 1;
		transact(state, () => {
			state.flag = true;
		}, { tag: "tx" });

		await Promise.resolve();

		expect(heard).toHaveLength(2);
		expect(heard[0]).toEqual({ path: "count", meta: undefined });
		expect(heard[1]).toEqual({ path: "flag", meta: { tag: "tx" } });
	});

	it("disarms with the last unsubscribe and re-arms fresh on the next subscribe", async () => {
		const state = createMutableState({ count: 0 });
		const heard = new Array<Array<Op>>();
		const unsubscribe = subscribe(state, (ops) => {
			heard.push([...ops]);
		});

		unsubscribe();
		vi.mocked(diffSnapshots).mockClear();

		state.count = 1;
		await Promise.resolve();

		expect(diffSnapshots).not.toHaveBeenCalled();
		expect(heard).toHaveLength(0);

		subscribe(state, (ops) => {
			heard.push([...ops]);
		});

		state.count = 2;
		await Promise.resolve();

		expect(heard).toEqual([
			[{ do: { op: "replace", path: ["count"], value: 2 }, undo: { op: "replace", path: ["count"], value: 1 } }],
		]);
	});
});

describe("grouped createMutableState", () => {
	it("delivers emissions to a group subscriber with the live state", () => {
		const group = createGroup();
		const emissions = new Array<{ state: object; ops: Array<Op>; meta: unknown }>();

		subscribe(group, (state, ops, meta) => {
			emissions.push({ state, ops: [...ops], meta });
		});

		const first = group.createState({ count: 0 });
		const second = group.createState({ count: 0 });

		transact(first, () => {
			first.count = 1;
		}, { transactionKey: "drag" });
		transact(second, () => {
			second.count = 2;
		});

		expect(emissions).toHaveLength(2);
		expect(emissions[0]?.state).toBe(first);
		expect(emissions[0]?.meta).toEqual({ transactionKey: "drag" });
		expect(emissions[1]?.state).toBe(second);
		expect(first.count).toBe(1);
	});
});
