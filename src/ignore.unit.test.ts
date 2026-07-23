import { createMutableState } from "./createMutableState";
import { ignore, type Ignored } from "./ignore";

describe("ignore", () => {
	it("keeps an ignored value's interior writable and shares the same reference", () => {
		const element = { currentTime: 0 };
		const state = createMutableState({ position: 0, element: ignore(element) });

		state.element.currentTime = 5;

		expect(element.currentTime).toBe(5);
		expect(state.element).toBe(element);
	});

	it("Ignored<T> types an ignored field in an explicit interface without erasing the marker", () => {
		interface Player {
			element: Ignored<{ currentTime: number }>;
		}

		const element = { currentTime: 0 };
		const state = createMutableState<Player>({ element: ignore(element) });

		state.element.currentTime = 9;

		expect(element.currentTime).toBe(9);
		expect(state.element).toBe(element);
	});
});
