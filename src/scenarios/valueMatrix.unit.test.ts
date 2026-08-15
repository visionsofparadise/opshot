import { snapshot } from "valtio/vanilla";

import { createMutableState } from "../createMutableState";
import { isSameIdentity } from "../identity";
import { applyOperations } from "../ops/applyOperations";
import { type Operation } from "../ops/operation";
import { subscribe } from "../subscribe";
import { transact } from "../transact/transact";
import { behaviorNames, catalog, type BehaviorName } from "./valueCatalog";

type ValueState = { value: unknown };

let probeCounter = 0;

const nextProbeKey = (): string => {
	probeCounter += 1;

	return `opshotProbe${probeCounter}`;
};

const driveInterior = (state: ValueState): void => {
	const value = state.value;
	const probeKey = nextProbeKey();

	if (Array.isArray(value)) {
		value.push(1);

		return;
	}

	if (value !== null && (typeof value === "object" || typeof value === "function")) {
		(value as Record<string, unknown>)[probeKey] = 1;

		return;
	}

	state.value = probeKey;
};

const isObjectOrFunction = (value: unknown): value is object =>
	value !== null && (typeof value === "object" || typeof value === "function");

const collectArityZeroMethods = (value: unknown): ReadonlyArray<string> => {
	const boxed = Object(value) as object;
	const names = new Array<string>();
	let prototype: object | null = boxed;

	while (prototype !== null && prototype !== Object.prototype) {
		for (const key of Object.getOwnPropertyNames(prototype)) {
			if (key === "constructor") continue;

			const descriptor = Object.getOwnPropertyDescriptor(prototype, key);

			if (descriptor === undefined || !("value" in descriptor)) continue;

			const candidate = descriptor.value;

			if (typeof candidate !== "function" || candidate.length !== 0) continue;

			names.push(key);
		}

		prototype = Reflect.getPrototypeOf(prototype);
	}

	return names;
};

const strictEqual = (left: unknown, right: unknown): boolean => {
	try {
		expect(left).toStrictEqual(right);

		return true;
	} catch {
		return false;
	}
};

const scenarios = {
	attachesAtCreate: (create) => {
		try {
			createMutableState({ value: create() });

			return true;
		} catch {
			return false;
		}
	},

	attachesByBareWrite: (create) => {
		try {
			const state = createMutableState<{ value?: unknown }>({});

			state.value = create();

			return true;
		} catch {
			return false;
		}
	},

	readBackIsRawReference: (create) => {
		try {
			const value = create();
			const state = createMutableState({ value });

			return Object.is(state.value, value);
		} catch {
			return false;
		}
	},

	readBackResolvesToSameIdentity: (create) => {
		try {
			const value = create();

			if (!isObjectOrFunction(value)) return false;

			const state = createMutableState({ value });
			const readBack = state.value;

			if (!isObjectOrFunction(readBack)) return false;

			return isSameIdentity(readBack, value);
		} catch {
			return false;
		}
	},

	emitsOnInteriorMutation: async (create) => {
		try {
			const state = createMutableState({ value: create() });
			const heard = new Array<Operation>();

			subscribe(state, (ops) => {
				heard.push(...ops);
			});

			driveInterior(state);
			await Promise.resolve();
			await Promise.resolve();

			return heard.length > 0;
		} catch {
			return false;
		}
	},

	roundTripsFaithfully: (create) => {
		try {
			const state = createMutableState({ value: create() });
			const heard = new Array<Array<Operation>>();

			subscribe(state, (ops) => {
				heard.push([...ops]);
			});

			const undoBaseline = snapshot(state).value;

			transact(state, () => {
				driveInterior(state);
			});

			const recorded = heard.flat().map((op) => ({ do: op.do, undo: op.undo }));
			const redoBaseline = snapshot(state).value;

			applyOperations(state, recorded, "undo");

			if (!strictEqual(snapshot(state).value, undoBaseline)) return false;

			applyOperations(state, recorded, "do");

			return strictEqual(snapshot(state).value, redoBaseline);
		} catch {
			return false;
		}
	},

	methodsWork: (create) => {
		try {
			const methodNames = collectArityZeroMethods(create());

			if (methodNames.length === 0) return true;

			for (const methodName of methodNames) {
				const state = createMutableState({ value: create() });
				const readBack = state.value;
				const method = Reflect.get(Object(readBack) as object, methodName);

				if (typeof method !== "function") return false;

				Reflect.apply(method, readBack, []);
			}

			return true;
		} catch {
			return false;
		}
	},

	methodInteriorWritesEmit: (create) => {
		try {
			const methodNames = collectArityZeroMethods(create());

			if (methodNames.length === 0) return false;

			for (const methodName of methodNames) {
				const state = createMutableState({ value: create() });
				const heard = new Array<Operation>();

				subscribe(state, (ops) => {
					heard.push(...ops);
				});

				const readBack = state.value;
				const method = Reflect.get(Object(readBack) as object, methodName);

				if (typeof method !== "function") continue;

				transact(state, () => {
					Reflect.apply(method, readBack, []);
				});

				if (heard.length > 0) return true;
			}

			return false;
		} catch {
			return false;
		}
	},
} satisfies Record<BehaviorName, (create: () => unknown) => boolean | Promise<boolean>>;

describe("value matrix", () => {
	for (const behaviorName of behaviorNames) {
		describe(behaviorName, () => {
			for (const entry of catalog) {
				it(entry.name, async () => {
					expect(await scenarios[behaviorName](entry.create)).toBe(entry.expect[behaviorName]);
				});
			}
		});
	}
});
