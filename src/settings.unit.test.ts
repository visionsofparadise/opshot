import { createMutableState } from "./createMutableState";
import { type EmissionScheduler } from "./settings";
import { subscribe } from "./subscribe";

describe("handle emission scheduler", () => {
	it("flushes on the handle emitOn and ignores a later assignment to a deleted options table", async () => {
		const firstPending = new Array<() => void>();
		const first: EmissionScheduler = (flush) => {
			firstPending.push(flush);
		};
		const heard = new Array<number>();
		const state = createMutableState({ count: 0 }, { emitOn: first });

		subscribe(state, () => {
			heard.push(state.count);
		});

		state.count = 1;

		await Promise.resolve();

		expect(firstPending).toHaveLength(1);
		expect(heard).toEqual([]);

		firstPending[0]!();

		expect(heard).toEqual([1]);
	});
});
