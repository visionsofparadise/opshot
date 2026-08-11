import { createMutableState } from "../createMutableState";
import { getRegisteredTarget } from "../identity";
import { TrackedDate } from "../tracked/trackedDate";
import { TrackedMap } from "../tracked/trackedMap";
import { TrackedSet } from "../tracked/trackedSet";
import { isCloneable } from "./cloneValue";
import {
	createAssignMutation,
	createDeleteMutation,
	createLinkMutation,
	getValueOriginal,
	isMutation,
	type LinkMutation,
	type Mutation,
} from "./operation";
import { shapeHalf } from "./operationShape";

const readValue = (half: Mutation): unknown => ("value" in half ? half.value : undefined);

describe("operation", () => {
	it("mints a fresh equal clone on every read of a cloneable value", () => {
		const original = { nested: { x: 1 }, list: [1, 2] };
		const half = createAssignMutation(["node"], original);

		expect(readValue(half)).not.toBe(readValue(half));
		expect(readValue(half)).toEqual(original);
		expect(getValueOriginal(half)).toBe(original);
	});

	it("reads non-cloneable values through the prototype accessor with no own value descriptor", () => {
		const run = (): string => "a";
		const half = createAssignMutation(["run"], run);

		expect(half.value).toBe(run);
		expect(Object.getOwnPropertyDescriptor(half, "value")).toBeUndefined();
		expect("value" in half).toBe(true);
		expect({ ...half }).not.toHaveProperty("value");
		expect(JSON.parse(JSON.stringify(half))).not.toHaveProperty("value");
	});

	it("stores a frozen copied path on every half", () => {
		const source = ["document", 1];
		const halves = [
			createAssignMutation(source, 1),
			createDeleteMutation(source),
			createLinkMutation(source, ["shared"]),
		];

		source[0] = "changed";

		for (const half of halves) {
			expect(half.path).toEqual(["document", 1]);
			expect(Object.isFrozen(half.path)).toBe(true);
		}
	});

	it("stores a frozen copied ref on a link half", () => {
		const path = ["alias"];
		const ref = ["shared", 0];
		const half = createLinkMutation(path, ref);

		path[0] = "changed";
		ref[0] = "changed";
		ref[1] = 9;

		expect(half.path).toEqual(["alias"]);
		expect(half.ref).toEqual(["shared", 0]);
		expect(Object.isFrozen(half.path)).toBe(true);
		expect(Object.isFrozen(half.ref)).toBe(true);
	});

	it("carries verb, path, and ref complete through spread and JSON copies of a link half", () => {
		const half = createLinkMutation(["alias"], ["shared"]);
		const spread = { ...half };
		const json = JSON.parse(JSON.stringify(half)) as LinkMutation;

		expect(spread).toEqual({ verb: "link", path: ["alias"], ref: ["shared"] });
		expect(json).toEqual({ verb: "link", path: ["alias"], ref: ["shared"] });
		expect(isMutation(half)).toBe(true);
		expect(isMutation(spread)).toBe(false);
		expect(isMutation(json)).toBe(false);
		expect(shapeHalf(half)).toEqual({ verb: "link", path: ["alias"], ref: ["shared"] });
	});

	it("keeps originals registered while public clone reads are independent", () => {
		const state = createMutableState({ value: { count: 1 } });
		const half = createAssignMutation(["value"], state.value);
		const publicValue = half.value;

		expect(getValueOriginal(half)).toBe(state.value);
		expect(publicValue).toEqual({ count: 1 });
		expect(publicValue).not.toBe(state.value);
		if (typeof publicValue !== "object" || publicValue === null) throw new Error("expected cloned value");
		expect(getRegisteredTarget(publicValue)).toBeUndefined();
	});

	it("brands originals and rejects spread, JSON, and structuredClone copies", () => {
		const half = createAssignMutation(["node"], { nested: true });

		expect(isMutation(half)).toBe(true);
		expect(isMutation({ ...half })).toBe(false);
		expect(isMutation(JSON.parse(JSON.stringify(half)))).toBe(false);
		expect(isMutation(structuredClone(half))).toBe(false);
	});

	it("keeps halves branded through an envelope spread", () => {
		const envelope = { do: createAssignMutation(["node"], { nested: true }), undo: createDeleteMutation(["node"]) };
		const spread = { ...envelope };

		expect(isMutation(spread.do)).toBe(true);
		expect(isMutation(spread.undo)).toBe(true);
	});

	it("clones plain-data facade op values through the generic path", () => {
		const map = new TrackedMap([["a", 1]]);
		const set = new TrackedSet([1]);
		const date = new TrackedDate(0);

		expect(isCloneable(map)).toBe(true);
		expect(isCloneable(set)).toBe(true);
		expect(isCloneable(date)).toBe(true);

		const mapHalf = createAssignMutation(["map"], map);
		const setHalf = createAssignMutation(["set"], set);
		const dateHalf = createAssignMutation(["date"], date);

		expect(mapHalf.value).not.toBe(map);
		expect(setHalf.value).not.toBe(set);
		expect(dateHalf.value).not.toBe(date);
		expect(mapHalf.value).toBeInstanceOf(TrackedMap);
		expect(setHalf.value).toBeInstanceOf(TrackedSet);
		expect(dateHalf.value).toBeInstanceOf(TrackedDate);
		expect([...(mapHalf.value as TrackedMap<string, number>)]).toEqual([["a", 1]]);
		expect([...(setHalf.value as TrackedSet<number>)]).toEqual([1]);
		expect((dateHalf.value as TrackedDate).getTime()).toBe(0);
		expect(getValueOriginal(mapHalf)).toBe(map);
	});
});
