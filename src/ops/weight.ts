import { getTrackedMapData } from "../tracked/trackedMap";
import { getTrackedSetData } from "../tracked/trackedSet";
import { isTrackedWrapper } from "../tracked/trackedWrapper";
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
}

const addWeight = (state: WeightState, amount: number): boolean => {
	state.weight += amount;

	return state.weight <= state.budget;
};

const getFacadeKind = (value: object): "TrackedMap" | "TrackedSet" | "TrackedDate" | undefined => {
	if (!isTrackedWrapper(value)) return undefined;

	const tag: unknown = Reflect.get(value, Symbol.toStringTag);

	if (tag === "TrackedMap" || tag === "TrackedSet" || tag === "TrackedDate") return tag;

	return undefined;
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

	const facadeKind = getFacadeKind(value);

	if (facadeKind === "TrackedDate") {
		addWeight(state, LEAF_WEIGHT);

		return;
	}

	if (facadeKind === "TrackedMap") {
		state.seen.add(value);

		if (!addWeight(state, NODE_WEIGHT)) return;

		for (const entry of getTrackedMapData(value)) {
			if (entry === null) continue;

			weigh(entry[0], state);
			if (state.weight > state.budget) return;

			weigh(entry[1], state);
			if (state.weight > state.budget) return;
		}

		return;
	}

	if (facadeKind === "TrackedSet") {
		state.seen.add(value);

		if (!addWeight(state, NODE_WEIGHT)) return;

		for (const entry of getTrackedSetData(value)) {
			if (entry === null) continue;

			weigh(entry[0], state);
			if (state.weight > state.budget) return;
		}

		return;
	}

	if (isCloneable(value)) {
		state.seen.add(value);

		if (!addWeight(state, NODE_WEIGHT)) return;

		for (const key of Object.keys(value)) {
			const descriptor = Reflect.getOwnPropertyDescriptor(value, key);

			if (!descriptor || !("value" in descriptor)) continue;
			if (!addWeight(state, KEY_WEIGHT)) return;

			weigh(descriptor.value, state);
			if (state.weight > state.budget) return;
		}

		return;
	}

	addWeight(state, LEAF_WEIGHT);
};

export const weighValue = (value: unknown, budget: number): number => {
	const state: WeightState = { weight: 0, budget, seen: new WeakSet() };

	weigh(value, state);

	return state.weight;
};
