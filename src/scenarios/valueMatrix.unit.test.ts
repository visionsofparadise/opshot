import { createState, type State } from "../createState";
import { isSameIdentity } from "../identity";
import { applyOps } from "../ops/applyOps";
import type { Op } from "../ops/operation";
import { getPathSelector } from "../ops/path";
import { TrackedDate } from "../tracked/trackedDate";
import { TrackedMap } from "../tracked/trackedMap";
import { TrackedSet } from "../tracked/trackedSet";
import { catalog, type CatalogEntry, type OperationLane } from "./valueCatalog";

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

type EffectiveOperationLane = OperationLane | "cyclic" | "trackedInterior" | "replaceValue";

const getOperationLane = (entry: CatalogEntry): EffectiveOperationLane => {
	if (entry.operationLane !== undefined) return entry.operationLane;
	if (entry.lane === "cyclic") return "cyclic";
	if (entry.lane === "tracked") return isPrimitive(entry.create()) ? "replaceValue" : "trackedInterior";
	if (entry.lane === "autoIgnored" || entry.lane === "ignored" || entry.lane === "leaf") return "replaceValue";

	return "none";
};

const readFacade = (facade: unknown): unknown => {
	if (facade instanceof TrackedMap) return [...facade];
	if (facade instanceof TrackedSet) return [...facade];
	if (facade instanceof TrackedDate) return facade.getTime();

	throw new Error("readFacade: not a tracked facade");
};

const driveFacade = (facade: unknown): void => {
	if (facade instanceof TrackedMap) facade.set(PROBE, 9);
	else if (facade instanceof TrackedSet) facade.add(999);
	else if (facade instanceof TrackedDate) facade.setTime(123456);
	else throw new Error("driveFacade: not a tracked facade");
};

const driveMapKey = (facade: unknown): void => {
	if (!(facade instanceof TrackedMap)) throw new Error("driveMapKey: not a tracked map");

	const key = facade.keys().next().value;

	if (typeof key !== "object" || key === null) throw new Error("driveMapKey: map has no object key");

	const id: unknown = Reflect.get(key, "id");

	if (typeof id !== "number") throw new Error("driveMapKey: map key has no numeric id");
	if (!Reflect.set(key, "id", id + 1)) throw new Error("driveMapKey: map key could not be mutated");
};

const getMapKey = (facade: unknown): object => {
	if (!(facade instanceof TrackedMap)) throw new Error("getMapKey: not a tracked map");

	const key = facade.keys().next().value;

	if (typeof key !== "object" || key === null) throw new Error("getMapKey: map has no object key");

	return key;
};

const getFacadeOperation = (facade: unknown): "add" | "replace" => {
	if (facade instanceof TrackedMap || facade instanceof TrackedSet) return "add";
	if (facade instanceof TrackedDate) return "replace";

	throw new Error("getFacadeOperation: not a tracked facade");
};

const driveSparseArray = (value: unknown): void => {
	if (!Array.isArray(value)) throw new Error("driveSparseArray: not an array");

	value[1] = undefined;
	delete value[3];
	value.length = 6;
};

const getFirstFacadeContent = (facade: unknown): unknown => {
	if (facade instanceof TrackedMap) return facade.values().next().value;
	if (facade instanceof TrackedSet) return facade.values().next().value;

	throw new Error("getFirstFacadeContent: facade has no contents");
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

		if (entry.lane === "registeredCopy") {
			expect(attach).toThrow(/snapshot generation is a read-view.*Clone the value, or replay through applyOps/s);

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

		if (entry.lane === "registeredCopy") {
			expect(attach).toThrow(/snapshot generation is a read-view.*Clone the value, or replay through applyOps/s);

			return;
		}

		attach();

		expect("value" in state.op.unwrap()).toBe(true);
	},
};

const opsAndReplay: Scenario = {
	name: "ops-and-replay",
	applies: (entry) => getOperationLane(entry) !== "none",
	run: (entry) => {
		const operationLane = getOperationLane(entry);
		const value = entry.create();
		const state = createState<{ value: unknown }>({ value });
		const heard = recordOwned(state);

		if (operationLane === "cyclic") {
			expect(() => {
				state.mutate((mutable) => {
					driveInterior(mutable.value as object);
				});
			}).toThrow(/cyclic value/);

			return;
		}

		const before = state.op.unwrap().value;
		const usesFacade = operationLane === "containerTranslation" || operationLane === "collectionKeyInterior";
		const beforeFacade = usesFacade ? readFacade(before) : undefined;
		const beforeMapKey = operationLane === "collectionKeyInterior" ? getMapKey(before) : undefined;

		state.mutate((mutable) => {
			switch (operationLane) {
				case "containerTranslation":
					driveFacade(mutable.value);
					break;
				case "collectionKeyInterior":
					driveMapKey(mutable.value);
					break;
				case "sparseArray":
					driveSparseArray(mutable.value);
					break;
				case "equalContentReplacement":
					mutable.value = { value: 1 };
					break;
				case "sameTargetInterior":
					(mutable.value as { value: number }).value = 2;
					break;
				case "trackedInterior":
					driveInterior(mutable.value as object);
					break;
				case "replaceValue":
					mutable.value = "__probe__";
					break;
		}
		});

		const ops = heard.flat();
		const mutated = state.op.unwrap().value;

		expect(ops.length).toBeGreaterThan(0);

		switch (operationLane) {
			case "containerTranslation":
				expect(ops.map((op) => op.do.op)).toEqual([getFacadeOperation(value)]);
				expect(ops[0]?.do.path[0]).toBe("value");
				break;
			case "collectionKeyInterior": {
				const operation = ops[0]?.do;
				const mutatedKey = getMapKey(mutated);

				if (beforeMapKey === undefined) throw new Error("map-key lane lost its before key");

				expect(ops).toHaveLength(1);
				expect(operation?.op).toBe("replace");
				expect(operation?.path[0]).toBe("value");
				expect(getPathSelector(operation?.path[1])?.kind).toBe("keyOf");
				expect(operation).toMatchObject({ op: "replace", path: ["value", expect.any(Object), "id"], value: 2 });
				expect(isSameIdentity(mutatedKey, beforeMapKey)).toBe(true);
				break;
			}
			case "sparseArray":
				expect(ops).toHaveLength(1);
				expect(ops[0]?.do.op).toBe("replace");
				expect(ops[0]?.do.path).toEqual(["value"]);
				break;
			case "equalContentReplacement":
				expect(ops).toHaveLength(1);
				expect(ops[0]?.do.op).toBe("replace");
				expect(ops[0]?.do.path).toEqual(["value"]);

				if (typeof before !== "object" || before === null || typeof mutated !== "object" || mutated === null) throw new Error("replacement lane did not produce object handles");

				expect(isSameIdentity(before, mutated)).toBe(false);
				break;
			case "sameTargetInterior":
				expect(ops).toHaveLength(1);
				expect(ops[0]?.do.op).toBe("replace");
				expect(ops[0]?.do.path).toEqual(["value", "value"]);

				if (typeof before !== "object" || before === null || typeof mutated !== "object" || mutated === null) throw new Error("interior lane did not produce object handles");

				expect(isSameIdentity(before, mutated)).toBe(true);
				break;
		}

		applyOps(
			state,
			[...ops].reverse().map((op) => op.undo),
		);

		const restored = state.op.unwrap().value;

		if (usesFacade) expect(readFacade(restored)).toEqual(beforeFacade);
		else expect(restored).toEqual(before);

		if (operationLane === "collectionKeyInterior") {
			if (beforeMapKey === undefined) throw new Error("map-key lane lost its before key");

			const restoredKey = getMapKey(restored);

			expect(isSameIdentity(restoredKey, beforeMapKey)).toBe(true);
			expect(restored instanceof TrackedMap ? restored.size : undefined).toBe(1);
		}

		if (operationLane === "equalContentReplacement" || operationLane === "sameTargetInterior") {
			if (typeof restored !== "object" || restored === null || typeof before !== "object" || before === null) throw new Error("undo did not produce object handles");

			expect(isSameIdentity(restored, before)).toBe(true);
		}

		applyOps(
			state,
			ops.map((op) => op.do),
		);

		const replayed = state.op.unwrap().value;

		if (usesFacade) expect(readFacade(replayed)).toEqual(readFacade(mutated));
		else expect(replayed).toEqual(mutated);

		if (operationLane === "collectionKeyInterior") {
			const replayedKey = getMapKey(replayed);
			const mutatedKey = getMapKey(mutated);

			expect(isSameIdentity(replayedKey, mutatedKey)).toBe(true);
			expect(replayed instanceof TrackedMap ? replayed.size : undefined).toBe(1);
		}

		if (operationLane === "equalContentReplacement" || operationLane === "sameTargetInterior") {
			if (typeof replayed !== "object" || replayed === null || typeof mutated !== "object" || mutated === null) throw new Error("redo did not produce object handles");

			expect(isSameIdentity(replayed, mutated)).toBe(true);
		}
	},
};

const unwrap: Scenario = {
	name: "unwrap",
	applies: (entry) => entry.lane === "tracked" || entry.lane === "ignored" || entry.lane === "autoIgnored" || entry.lane === "leaf",
	run: (entry) => {
		const value = entry.create();
		const state = createState<{ value: unknown }>({ value });
		const unwrapped = state.op.unwrap().value;

		if (entry.lane === "tracked") {
			expect(unwrapped).toEqual(value);

			if (typeof unwrapped === "object" && unwrapped !== null && typeof value === "object" && value !== null) {
				expect(unwrapped).not.toBe(value);
				expect(isSameIdentity(unwrapped, value)).toBe(true);
			}

			return;
		}

		expect(unwrapped).toBe(value);
	},
};

const snapshotWrite: Scenario = {
	name: "snapshot-write",
	applies: (entry) => entry.lane !== "throwsAtAttach" && entry.lane !== "registeredCopy" && firstDataKey(entry.create()) !== undefined,
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
		if (getOperationLane(entry) === "none") return false;
		if (entry.lane === "ignored" || entry.lane === "leaf") return true;

		return entry.lane === "tracked" && !isPrimitive(entry.create());
	},
	run: async (entry) => {
		const value = entry.create();
		const state = createState<{ value: unknown }>({ value });
		const heard = new Array<Array<Op>>();

		state.op.subscribe((_state, ops, emission) => {
			if (emission.isSideEffect) heard.push(ops);
		});

		const rootValue: unknown = Reflect.get(state.op.unsafeMutable, "value");

		if (getOperationLane(entry) === "containerTranslation") {
			driveFacade(rootValue);
		} else if (getOperationLane(entry) === "collectionKeyInterior") {
			driveMapKey(rootValue);
		} else {
			if (rootValue === null || (typeof rootValue !== "object" && typeof rootValue !== "function")) throw new Error("a watchdog row did not produce an object");

			driveInterior(rootValue);
		}

		await Promise.resolve();
		await Promise.resolve();

		if (entry.lane === "tracked") {
			expect(heard.flat().length).toBeGreaterThan(0);
		} else {
			expect(heard).toHaveLength(0);
		}
	},
};

const facadeContents: Scenario = {
	name: "facade-contents",
	applies: (entry) => entry.contentsLane !== undefined,
	run: (entry) => {
		const facade = entry.create();
		const original = getFirstFacadeContent(facade);
		const state = createState<{ value: unknown }>({ value: facade });
		const heard = recordOwned(state);
		const snapshotContent = getFirstFacadeContent(state.op.unwrap().value);

		if (entry.contentsLane === "ignored") expect(snapshotContent).toBe(original);

		state.mutate((mutable) => {
			const content = getFirstFacadeContent(mutable.value);

			if (typeof content !== "object" || content === null) throw new Error("facade contents lane did not produce an object");

			driveInterior(content);
		});

		expect(heard).toHaveLength(0);
		expect(getFirstFacadeContent(state.op.unwrap().value)).toBe(original);
	},
};

const scenarios: ReadonlyArray<Scenario> = [attachAtCreate, attachViaMutate, opsAndReplay, unwrap, snapshotWrite, watchdogReport, facadeContents];

describe("value matrix", () => {
	for (const scenario of scenarios) {
		describe(scenario.name, () => {
			const applicable = catalog.filter((entry) => scenario.applies(entry));

			for (const entry of applicable) {
				const run = async (): Promise<void> => {
					await scenario.run(entry);
				};
				it(entry.name, run);
			}
		});
	}

	it("exercises every catalog entry in a lane-appropriate scenario beyond the universal attach pair", () => {
		// The two attach scenarios apply to everything, so require a behavioral scenario too -- except
		// throwsAtAttach, which legitimately never gets past attach in the node matrix.
		const behavioral = [opsAndReplay, unwrap, snapshotWrite, watchdogReport];

		for (const entry of catalog) {
			const attachOnly = entry.lane === "throwsAtAttach" || entry.lane === "registeredCopy";
			const covered = attachOnly ? attachAtCreate.applies(entry) : behavioral.some((scenario) => scenario.applies(entry));

			expect(covered, `${entry.name} is not exercised beyond attach`).toBe(true);
		}
	});
});
