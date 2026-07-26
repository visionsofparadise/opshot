import { subscribe } from "../subscribe";
import { transact } from "../transact";
import { snapshot } from "valtio/vanilla";
import { createMutableState } from "../createMutableState";
import { type Op } from "../ops/operation";

const recordEmissions = <T extends object>(state: T): Array<{ state: T; ops: Array<Op> }> => {
	const emissions = new Array<{ state: T; ops: Array<Op> }>();

	subscribe(state, (ops) => {
		emissions.push({ state, ops: [...ops] });
	});

	return emissions;
};

describe("snapshotAccessors: accessor preservation", () => {
	interface Temperature {
		celsius: number;
		readonly fahrenheit: number;
		other: { n: number };
	}

	const createTemperature = (): Temperature =>
		createMutableState<Temperature>({
			celsius: 0,
			other: { n: 1 },
			get fahrenheit() {
				return (this.celsius * 9) / 5 + 32;
			},
		});

	it("keeps an own getter live on the live object, recomputing after writes", () => {
		const state = createTemperature();
		const emissions = recordEmissions(state);

		expect(state.fahrenheit).toBe(32);
		expect(Object.getOwnPropertyDescriptor(state, "fahrenheit")?.get).toBeTypeOf("function");

		transact(state, () => {
			state.celsius = 20;
		});

		const second = emissions[0]?.state;

		if (!second) throw new Error("the subscriber heard no emission");

		expect(second).toBe(state);
		expect(second.fahrenheit).toBe(68);
		expect(Object.getOwnPropertyDescriptor(second, "fahrenheit")?.get).toBeTypeOf("function");
		expect(state.fahrenheit).toBe(68);
	});

	it("preserves snapshot cache identity and untouched-subtree structural sharing", () => {
		const state = createTemperature();
		const emissions = recordEmissions(state);

		const first = snapshot(state);

		expect(snapshot(state)).toBe(first);

		transact(state, () => {
			state.celsius = 20;
		});

		const second = emissions[0]?.state;

		if (!second) throw new Error("the subscriber heard no emission");

		expect(second).not.toBe(first);
		expect(second.other).toBe(state.other);
	});
});
