import { TrackedDate } from "./trackedDate";
import { TrackedMap } from "./trackedMap";
import { TrackedSet } from "./trackedSet";

const lock = (facade: object, mutationKey: string): void => {
	const descriptor = Reflect.getOwnPropertyDescriptor(facade, mutationKey);

	if (descriptor === undefined || !("value" in descriptor)) throw new Error("missing mutation key");

	Object.defineProperty(facade, mutationKey, { ...descriptor, writable: false });
};

describe("§1.4 an edge is dangerous and untracked when it is an exotic hidden store", () => {
	it("throws when the mutation key is a non-writable data property", () => {
		const map = new TrackedMap([["a", 1]]);
		const set = new TrackedSet([1]);
		const when = new TrackedDate(0);

		lock(map, "count");
		lock(set, "count");
		lock(when, "epochMs");

		expect(() => map.set("b", 2)).toThrow("opshot: cannot mutate a tracked collection snapshot");
		expect(() => set.add(2)).toThrow("opshot: cannot mutate a tracked collection snapshot");
		expect(() => when.setTime(1)).toThrow("opshot: cannot mutate a tracked collection snapshot");

		expect(map.get("a")).toBe(1);
		expect(set.has(1)).toBe(true);
		expect(when.getTime()).toBe(0);
	});
});
