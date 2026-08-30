import { createMutableState } from "../createMutableState";
import { subscribe } from "../subscribe";
import { batch } from "../batch";

const capturingEmitOn = (): { emitOn: (flush: () => void) => void; thrown: () => unknown } => {
	let thrown: unknown;

	return {
		emitOn: (flush) => {
			try {
				flush();
			} catch (error) {
				thrown = error;
			}
		},
		thrown: () => thrown,
	};
};

describe("emitterDeliver", () => {
	it("one throwing subscriber does not stop its siblings, and the failure rethrows as itself after delivery completes", async () => {
		const capture = capturingEmitOn();
		const state = createMutableState({ n: 0 }, { emitOn: capture.emitOn });
		const called = new Array<string>();
		const failure = new Error("listener failure");

		subscribe(state, () => {
			called.push("first");
		});
		subscribe(state, () => {
			called.push("second");

			throw failure;
		});
		subscribe(state, () => {
			called.push("third");
		});

		state.n = 1;

		await Promise.resolve();

		expect(called).toEqual(["first", "second", "third"]);
		expect(capture.thrown()).toBe(failure);
	});

	it("several throwing subscribers rethrow as one AggregateError with the delivery-failure message", async () => {
		const capture = capturingEmitOn();
		const state = createMutableState({ n: 0 }, { emitOn: capture.emitOn });
		const first = new Error("first failure");
		const second = new Error("second failure");

		subscribe(state, () => {
			throw first;
		});
		subscribe(state, () => {
			throw second;
		});

		state.n = 1;

		await Promise.resolve();

		const thrown = capture.thrown();

		expect(thrown).toBeInstanceOf(AggregateError);
		expect((thrown as AggregateError).message).toBe("opshot: listeners failed during delivery");
		expect((thrown as AggregateError).errors).toEqual([first, second]);
	});

	it("a write made by a subscriber during delivery is delivered after the current loop completes", () => {
		const cause = createMutableState({ n: 0 });
		const effect = createMutableState({ n: 0 });
		const order = new Array<string>();

		subscribe(cause, () => {
			order.push("first hears cause");

			batch(() => {
				effect.n += 1;
			});
		});
		subscribe(effect, () => {
			order.push("hears effect");
		});
		subscribe(cause, () => {
			order.push("second hears cause");
		});

		batch(() => {
			cause.n += 1;
		});

		expect(order).toEqual(["first hears cause", "second hears cause", "hears effect"]);
	});
});
