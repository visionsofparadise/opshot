import { createState, type State } from "../createState";
import { applyOps } from "../ops/applyOps";
import type { Op } from "../ops/operation";
import { TrackedDate } from "../tracked/trackedDate";
import { TrackedMap } from "../tracked/trackedMap";
import { TrackedSet } from "../tracked/trackedSet";
import { catalog, type CatalogEntry } from "./valueCatalog";

type ValueState = State<{ value: unknown }>;

const PROBE = "opshotProbe";

const isPrimitive = (value: unknown): boolean => value === null || (typeof value !== "object" && typeof value !== "function");

const driveInterior = (target: object): void => {
	if (Array.isArray(target)) target.push(1);
	else (target as Record<string, unknown>)[PROBE] = 1;
};

const firstDataKey = (value: unknown): string | undefined => {
	if (typeof value !== "object" || value === null) return undefined;

	for (const key of Object.keys(value)) {
		const descriptor = Object.getOwnPropertyDescriptor(value, key);

		if (descriptor && "value" in descriptor) return key;
	}

	return undefined;
};

const recordOwned = (state: ValueState): Array<Array<Op>> => {
	const heard = new Array<Array<Op>>();

	state.op.subscribe((_state, ops, emission) => {
		if (!emission.isSideEffect) heard.push(ops);
	});

	return heard;
};

const readWrapper = (wrapper: unknown): unknown => {
	if (wrapper instanceof TrackedMap) return [...wrapper];
	if (wrapper instanceof TrackedSet) return [...wrapper];
	if (wrapper instanceof TrackedDate) return wrapper.getTime();

	throw new Error("readWrapper: not a tracked wrapper");
};

const driveWrapper = (wrapper: unknown): void => {
	if (wrapper instanceof TrackedMap) wrapper.set(PROBE, 9);
	else if (wrapper instanceof TrackedSet) wrapper.add(999);
	else if (wrapper instanceof TrackedDate) wrapper.setTime(123456);
	else throw new Error("driveWrapper: not a tracked wrapper");
};

interface Scenario {
	readonly name: string;
	readonly applies: (entry: CatalogEntry) => boolean;
	readonly run: (entry: CatalogEntry) => void | Promise<void>;
}

const attachAtCreate: Scenario = {
	name: "attach-at-create",
	applies: () => true,
	run: (entry) => {
		const value = entry.create();
		const attach = (): ValueState => createState<{ value: unknown }>({ value });

		if (entry.lane === "throwsAtAttach") {
			expect(attach).toThrow(/Options:/);

			return;
		}

		const state = attach();

		expect("value" in state.op.unwrap()).toBe(true);
	},
};

const attachViaMutate: Scenario = {
	name: "attach-via-mutate",
	applies: () => true,
	run: (entry) => {
		const state = createState<{ value?: unknown }>({});
		const value = entry.create();
		const attach = (): void => {
			state.mutate((mutable) => {
				mutable.value = value;
			});
		};

		if (entry.lane === "throwsAtAttach") {
			expect(attach).toThrow(/Options:/);

			return;
		}

		attach();

		expect("value" in state.op.unwrap()).toBe(true);
	},
};

const opsAndReplay: Scenario = {
	// reactElement is retrack-specific: a frozen element with a $$typeof ride-along that neither
	// round-trips through a diff nor accepts an interior poke.
	name: "ops-and-replay",
	applies: (entry) => entry.lane !== "throwsAtAttach" && entry.name !== "reactElement",
	run: (entry) => {
		const value = entry.create();
		const state = createState<{ value: unknown }>({ value });
		const heard = recordOwned(state);

		if (entry.lane === "cyclic") {
			expect(() => {
				state.mutate((mutable) => {
					driveInterior(mutable.value as object);
				});
			}).toThrow(/cyclic value/);

			return;
		}

		if (entry.lane === "wrapper") {
			const before = readWrapper(value);

			state.mutate((mutable) => {
				driveWrapper(mutable.value);
			});

			const ops = heard.flat();
			const mutated = readWrapper(value);

			expect(ops).toHaveLength(1);

			applyOps(state, [ops[0]!.undo]);
			expect(readWrapper(value)).toEqual(before);

			applyOps(state, [ops[0]!.do]);
			expect(readWrapper(value)).toEqual(mutated);

			return;
		}

		if (isPrimitive(value)) {
			const before = state.op.unwrap().value;

			state.mutate((mutable) => {
				mutable.value = "__probe__";
			});

			const ops = heard.flat();

			expect(ops).toHaveLength(1);
			expect(ops[0]?.do.op).toBe("replace");
			expect(ops[0]?.do.path).toBe("/value");

			applyOps(state, [ops[0]!.undo]);
			expect(state.op.unwrap().value).toBe(before);

			applyOps(state, [ops[0]!.do]);
			expect(state.op.unwrap().value).toBe("__probe__");

			return;
		}

		const before = state.op.unwrap().value;

		state.mutate((mutable) => {
			if (entry.lane === "tracked") driveInterior(mutable.value as object);
			else mutable.value = { replaced: true };
		});

		const ops = heard.flat();
		const poked = state.op.unwrap().value;

		expect(ops.length).toBeGreaterThan(0);

		applyOps(
			state,
			[...ops].reverse().map((op) => op.undo),
		);
		expect(state.op.unwrap().value).toEqual(before);

		applyOps(
			state,
			ops.map((op) => op.do),
		);
		expect(state.op.unwrap().value).toEqual(poked);
	},
};

const unwrap: Scenario = {
	name: "unwrap",
	applies: (entry) => entry.lane === "tracked" || entry.lane === "ignored" || entry.lane === "autoIgnored" || entry.lane === "leaf" || entry.lane === "wrapper",
	run: (entry) => {
		const value = entry.create();
		const state = createState<{ value: unknown }>({ value });
		const unwrapped = state.op.unwrap().value;

		if (entry.lane === "tracked") {
			expect(unwrapped).toEqual(value);

			return;
		}

		expect(unwrapped).toBe(value);
	},
};

const snapshotWrite: Scenario = {
	name: "snapshot-write",
	applies: (entry) => entry.lane !== "throwsAtAttach" && firstDataKey(entry.create()) !== undefined,
	run: (entry) => {
		const value = entry.create();
		const state = createState<{ value: unknown }>({ value });
		const key = firstDataKey(value)!;
		const snapshotValue = state.op.unwrap().value as Record<string, unknown>;

		const write = (): void => {
			snapshotValue[key] = 999;
		};

		if (entry.lane === "ignored") expect(write).not.toThrow();
		else expect(write).toThrow();
	},
};

const watchdogReport: Scenario = {
	name: "watchdog-report",
	applies: (entry) => {
		// reactElement is a frozen leaf here; its interior cannot be poked. It rides the retrack sibling.
		if (entry.name === "reactElement") return false;
		if (entry.lane === "ignored" || entry.lane === "leaf" || entry.lane === "wrapper") return true;

		return entry.lane === "tracked" && !isPrimitive(entry.create());
	},
	run: async (entry) => {
		const value = entry.create();
		const state = createState<{ value: unknown }>({ value });
		const heard = new Array<Array<Op>>();

		state.op.subscribe((_state, ops, emission) => {
			if (emission.isSideEffect) heard.push(ops);
		});

		const root = state.op.unsafeMutable as { value: unknown };

		if (entry.lane === "wrapper") driveWrapper(root.value);
		else driveInterior(root.value as object);

		await Promise.resolve();
		await Promise.resolve();

		if (entry.lane === "tracked" || entry.lane === "wrapper") {
			expect(heard.flat().length).toBeGreaterThan(0);
		} else {
			expect(heard).toHaveLength(0);
		}
	},
};

const scenarios: ReadonlyArray<Scenario> = [attachAtCreate, attachViaMutate, opsAndReplay, unwrap, snapshotWrite, watchdogReport];

describe("value matrix", () => {
	for (const scenario of scenarios) {
		describe(scenario.name, () => {
			const applicable = catalog.filter((entry) => scenario.applies(entry));

			it.each(applicable.map((entry) => [entry.name, entry] as const))("%s", async (_name, entry) => {
				await scenario.run(entry);
			});
		});
	}

	it("exercises every catalog entry in a lane-appropriate scenario beyond the universal attach pair", () => {
		// The two attach scenarios apply to everything, so require a behavioral scenario too -- except
		// throwsAtAttach, which legitimately never gets past attach in the node matrix.
		const behavioral = [opsAndReplay, unwrap, snapshotWrite, watchdogReport];

		for (const entry of catalog) {
			const covered = entry.lane === "throwsAtAttach" ? attachAtCreate.applies(entry) : behavioral.some((scenario) => scenario.applies(entry));

			expect(covered, `${entry.name} is not exercised beyond attach`).toBe(true);
		}
	});
});
