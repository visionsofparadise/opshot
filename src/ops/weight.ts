import { isCloneable } from "./cloneValue";

export const NODE_WEIGHT = 32;
export const KEY_WEIGHT = 16;
export const CHARACTER_WEIGHT = 2;
export const LEAF_WEIGHT = 16;
export const OPERATION_WEIGHT = 512;

interface WeightState {
	weight: number;
	readonly budget: number;
	readonly seen: WeakSet<object>;
	readonly onNode: ((node: object) => void) | undefined;
}

const addWeight = (state: WeightState, amount: number): boolean => {
	state.weight += amount;

	return state.weight <= state.budget;
};

const weigh = (value: unknown, state: WeightState): void => {
	if (state.weight > state.budget) return;

	if (typeof value === "string") {
		addWeight(state, LEAF_WEIGHT + CHARACTER_WEIGHT * value.length);

		return;
	}

	if (value === null || (typeof value !== "object" && typeof value !== "function")) {
		addWeight(state, LEAF_WEIGHT);

		return;
	}

	if (state.seen.has(value)) return;

	if (isCloneable(value)) {
		state.seen.add(value);
		state.onNode?.(value);

		if (!addWeight(state, NODE_WEIGHT)) return;

		for (const key of Object.keys(value)) {
			const descriptor = Reflect.getOwnPropertyDescriptor(value, key);

			if (!descriptor || !("value" in descriptor)) continue;

			if (!addWeight(state, KEY_WEIGHT)) return;

			weigh(descriptor.value, state);

			if (state.weight > state.budget) return;
		}
	}
};

export const weighValue = (value: unknown, budget: number, onNode?: (node: object) => void): number => {
	const state: WeightState = { weight: 0, budget, seen: new WeakSet(), onNode };

	weigh(value, state);

	return state.weight;
};
