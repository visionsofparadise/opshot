import { createMutableState } from "./createMutableState";
import { ignore } from "./ignore";
import { isSameIdentity } from "./identity";
import { isState } from "./isState";
import { type Operation } from "./ops/operation";
import { shapeOps } from "./ops/operationShape";
import { subscribe } from "./subscribe";
import { transact } from "./transact/transact";
import { unsafeTrack } from "./unsafeTrack";

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

const recordEmissions = (state: object): Array<{ ops: Array<Operation>; meta: unknown }> => {
	const emissions = new Array<{ ops: Array<Operation>; meta: unknown }>();

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

	it("emits once per transact with the caller's meta", () => {
		const state = createCounter();
		const emissions = recordEmissions(state);

		transact(
			state,
			() => {
				state.count = 1;
			},
			{ transactionKey: "drag", replay: true },
		);

		expect(emissions).toHaveLength(1);
		expect(shapeOps(emissions[0]?.ops ?? [])).toEqual([
			{ do: { verb: "assign", path: ["count"], value: 1 }, undo: { verb: "assign", path: ["count"], value: 0 } },
		]);
		expect(emissions[0]?.meta).toEqual({ transactionKey: "drag", replay: true });

		transact(state, () => {
			state.count = 2;
		});

		expect(emissions).toHaveLength(2);
		expect(emissions[1]?.meta).toBeUndefined();
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

	it("restores tracked nodes when the transaction callback throws", () => {
		const state = createCounter();
		const emissions = recordEmissions(state);

		expect(() =>
			transact(state, () => {
				state.count = 1;
				throw new Error("boom");
			}),
		).toThrow("boom");

		expect(state.count).toBe(0);
		expect(emissions).toHaveLength(0);

		state.increment();
		expect(state.count).toBe(1);
	});

	it("stops calling a listener after its remover runs", () => {
		const state = createCounter();
		const emissions = new Array<Array<Operation>>();
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
		const entries = new Array<string>();
		const state = createMutableState({
			index: 0,
			entries: ignore(entries),
			append(entry: string) {
				entries.push(entry);
				this.index += 1;
			},
		});
		const emissions = recordEmissions(state);

		transact(state, () => {
			state.append("one");
		});

		expect(state.entries).toEqual(["one"]);
		expect(emissions).toHaveLength(1);
		expect(shapeOps(emissions[0]?.ops ?? [])).toEqual([
			{ do: { verb: "assign", path: ["index"], value: 1 }, undo: { verb: "assign", path: ["index"], value: 0 } },
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

		expect(shapeOps(emissions[0]?.ops ?? [])).toEqual([
			{ do: { verb: "assign", path: ["count"], value: 1 }, undo: { verb: "assign", path: ["count"], value: 0 } },
		]);
		expect(state.doubled).toBe(2);
	});

	it("reports a bare write as ops on the microtask flush", async () => {
		const state = createMutableState({ count: 0 });
		const heard = new Array<{ ops: Array<Operation>; meta: unknown }>();

		subscribe(state, (ops, meta) => {
			heard.push({ ops: [...ops], meta });
		});

		state.count = 5;

		expect(heard).toHaveLength(0);

		await Promise.resolve();

		expect(heard.map((entry) => ({ ops: shapeOps(entry.ops), meta: entry.meta }))).toEqual([
			{
				ops: [
					{
						do: { verb: "assign", path: ["count"], value: 5 },
						undo: { verb: "assign", path: ["count"], value: 0 },
					},
				],
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

		transact(
			state,
			() => {
				state.count = 1;
			},
			{},
		);

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
		transact(
			state,
			() => {
				state.flag = true;
			},
			{ tag: "tx" },
		);

		await Promise.resolve();

		expect(heard).toHaveLength(2);
		expect(heard[0]).toEqual({ path: "count", meta: undefined });
		expect(heard[1]).toEqual({ path: "flag", meta: { tag: "tx" } });
	});
});

describe("createMutableState: root certification", () => {
	it("throws at a Map root", () => {
		expect(() => createMutableState(new Map<string, number>())).toThrow();
	});

	it("throws at an own function property on a class instance root", () => {
		class Arrow {
			count = 0;
			bump = (): void => {
				this.count += 1;
			};
		}

		expect(() => createMutableState(new Arrow())).toThrow();
	});

	it("returns a frozen plain root as that node", () => {
		const frozen = Object.freeze({ count: 0 });

		expect(createMutableState(frozen)).toBe(frozen);
		expect(isState(frozen)).toBe(false);
	});

	it("returns an already-tracked root as that node", () => {
		const existing = createMutableState({ count: 0 });

		expect(createMutableState(existing)).toBe(existing);
	});

	it("returns an ignore()d factory argument as that node", () => {
		const object = { count: 0 };

		expect(createMutableState(ignore(object))).toBe(object);
		expect(isState(object)).toBe(false);
	});

	it("tracks a clean-class root", () => {
		class Counter {
			count = 0;
		}

		const state = createMutableState(new Counter());
		const emissions = recordEmissions(state);

		transact(state, () => {
			state.count = 1;
		});

		expect(state.count).toBe(1);
		expect(emissions).toHaveLength(1);
		expect(shapeOps(emissions[0]?.ops ?? [])).toEqual([
			{ do: { verb: "assign", path: ["count"], value: 1 }, undo: { verb: "assign", path: ["count"], value: 0 } },
		]);
	});

	it("admits a dangerous Map root under strict false", () => {
		const state = createMutableState(new Map<string, number>(), { strict: false });

		expect(isState(state)).toBe(true);
		expect(state).toBeInstanceOf(Map);
	});

	it("emits from a subscribed write on a root the caller marked with unsafeTrack", () => {
		class Arrow {
			count = 0;
			bump = (): void => {
				this.count += 1;
			};
		}

		const state = createMutableState(unsafeTrack(new Arrow()));
		const emissions = recordEmissions(state);

		transact(state, () => {
			state.count = 1;
		});

		expect(state.count).toBe(1);
		expect(emissions.map((emission) => shapeOps(emission.ops))).toEqual([
			[{ do: { verb: "assign", path: ["count"], value: 1 }, undo: { verb: "assign", path: ["count"], value: 0 } }],
		]);
	});
});
