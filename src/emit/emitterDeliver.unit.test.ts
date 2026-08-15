import { createMutableState } from "../createMutableState";
import { subscribe } from "../subscribe";
import { transact } from "../transact/transact";

interface Counter {
	n: number;
}

describe("deliver", () => {
	it("runs every listener when one throws, and rethrows the single failure as itself", () => {
		const state = createMutableState<Counter>({ n: 0 });
		const called = new Array<string>();
		const failure = new Error("listener failure");

		subscribe(state, () => called.push("first"));
		subscribe(state, () => {
			called.push("second");

			throw failure;
		});
		subscribe(state, () => called.push("third"));

		expect(() =>
			transact(state, () => {
				state.n = 1;
			}),
		).toThrow(failure);
		expect(called).toEqual(["first", "second", "third"]);
	});

	it("aggregates several listener failures", () => {
		const state = createMutableState<Counter>({ n: 0 });
		const first = new Error("first failure");
		const second = new Error("second failure");

		subscribe(state, () => {
			throw first;
		});
		subscribe(state, () => {
			throw second;
		});

		let raised: unknown;

		try {
			transact(state, () => {
				state.n = 1;
			});
		} catch (error) {
			raised = error;
		}

		expect(raised).toBeInstanceOf(AggregateError);
		expect((raised as AggregateError).errors).toEqual([first, second]);
	});

	it("delivers a re-entrant emission after the current loop rather than inside it", () => {
		const cause = createMutableState<Counter>({ n: 0 });
		const effect = createMutableState<Counter>({ n: 0 });
		const order = new Array<string>();

		subscribe(cause, () => {
			order.push("first hears cause");

			transact(effect, () => {
				effect.n += 1;
			});
		});
		subscribe(effect, () => order.push("hears effect"));
		subscribe(cause, () => order.push("second hears cause"));

		transact(cause, () => {
			cause.n += 1;
		});

		expect(order).toEqual(["first hears cause", "second hears cause", "hears effect"]);
	});

	it("emits a write on another state after the transacted state's listener transact", async () => {
		const transacted = createMutableState<Counter>({ n: 0 });
		const cause = createMutableState<Counter>({ n: 0 });
		const effect = createMutableState<Counter>({ n: 0 });
		const observed = new Array<string>();

		subscribe(cause, () => observed.push("cause"));
		subscribe(effect, () => observed.push("effect"));
		subscribe(transacted, () => {
			transact(effect, () => {
				effect.n += 1;
			});
		});

		transact(transacted, () => {
			transacted.n += 1;
			cause.n += 1;
		});

		expect(observed).toEqual(["effect"]);

		await Promise.resolve();

		expect(observed).toEqual(["effect", "cause"]);
	});

	it("raises the transacted state's listener failure without waiting for another state's Write", () => {
		const transacted = createMutableState<Counter>({ n: 0 });
		const other = createMutableState<Counter>({ n: 0 });
		const heard = new Array<string>();
		const transactedFailure = new Error("transacted listener failure");

		subscribe(transacted, () => {
			heard.push("transacted");

			throw transactedFailure;
		});
		subscribe(other, () => {
			heard.push("other");
		});

		expect(() =>
			transact(transacted, () => {
				transacted.n += 1;
				other.n += 1;
			}),
		).toThrow(transactedFailure);
		expect(heard).toEqual(["transacted"]);
	});

	it("a listener that joins another state before that state's Write flushes hears the Write", async () => {
		const transacted = createMutableState<Counter>({ n: 0 });
		const other = createMutableState<Counter>({ n: 0 });
		const heard = new Array<string>();

		subscribe(other, () => heard.push("subscribed before the frame"));
		subscribe(transacted, () => {
			subscribe(other, () => heard.push("subscribed mid-frame"));
		});

		transact(transacted, () => {
			transacted.n += 1;
			other.n += 1;
		});

		expect(heard).toEqual([]);

		await Promise.resolve();

		expect(heard).toEqual(["subscribed before the frame", "subscribed mid-frame"]);
	});

	it("delivers both emissions before the outermost transact returns", () => {
		const cause = createMutableState<Counter>({ n: 0 });
		const effect = createMutableState<Counter>({ n: 0 });
		const heard = new Array<string>();

		subscribe(cause, () => {
			heard.push("cause");

			transact(effect, () => {
				effect.n += 1;
			});
		});
		subscribe(effect, () => heard.push("effect"));

		transact(cause, () => {
			cause.n += 1;
		});

		expect(heard).toEqual(["cause", "effect"]);
	});

	it("delivers before returning from ordinary code, but not from inside a listener", () => {
		const outer = createMutableState<Counter>({ n: 0 });
		const inner = createMutableState<Counter>({ n: 0 });
		let delivered = false;
		const deliveredBeforeReturn = new Array<boolean>();

		subscribe(inner, () => {
			delivered = true;
		});

		delivered = false;

		transact(inner, () => {
			inner.n += 1;
		});

		deliveredBeforeReturn.push(delivered);

		subscribe(outer, () => {
			delivered = false;

			transact(inner, () => {
				inner.n += 1;
			});

			deliveredBeforeReturn.push(delivered);
		});

		transact(outer, () => {
			outer.n += 1;
		});

		expect(deliveredBeforeReturn).toEqual([true, false]);
	});

	it("does not strand a queued delivery when a listener throws, nor poison a later emission", () => {
		const cause = createMutableState<Counter>({ n: 0 });
		const effect = createMutableState<Counter>({ n: 0 });
		const later = createMutableState<Counter>({ n: 0 });
		const heard = new Array<string>();
		const failure = new Error("listener failure");

		subscribe(cause, () => {
			transact(effect, () => {
				effect.n += 1;
			});

			throw failure;
		});
		subscribe(effect, () => heard.push("effect"));
		subscribe(later, () => heard.push("later"));

		expect(() =>
			transact(cause, () => {
				cause.n += 1;
			}),
		).toThrow(failure);
		expect(heard).toEqual(["effect"]);

		transact(later, () => {
			later.n += 1;
		});

		expect(heard).toEqual(["effect", "later"]);
	});

	it("never re-delivers the ops a throwing listener missed", () => {
		const state = createMutableState<Counter>({ n: 0 });
		const heard = new Array<number>();

		subscribe(state, () => {
			throw new Error("listener failure");
		});
		subscribe(state, () => heard.push(state.n));

		expect(() =>
			transact(state, () => {
				state.n = 1;
			}),
		).toThrow("listener failure");
		expect(() =>
			transact(state, () => {
				state.n = 2;
			}),
		).toThrow("listener failure");

		expect(heard).toEqual([1, 2]);
	});

	it("delivers a queued emission to a listener removed during the delivery that queued it", () => {
		const cause = createMutableState<Counter>({ n: 0 });
		const effect = createMutableState<Counter>({ n: 0 });
		const heard = new Array<number>();
		const removeEffect = subscribe(effect, () => heard.push(effect.n));

		subscribe(cause, () => {
			transact(effect, () => {
				effect.n += 1;
			});
		});
		subscribe(cause, () => removeEffect());

		transact(cause, () => {
			cause.n += 1;
		});

		expect(heard).toEqual([1]);
	});

	it("delivers a pending bare write when its listener unsubscribes from inside a delivery", () => {
		const cause = createMutableState<Counter>({ n: 0 });
		const effect = createMutableState<Counter>({ n: 0 });
		const heard = new Array<number>();
		const removeEffect = subscribe(effect, () => heard.push(effect.n));

		subscribe(cause, () => {
			effect.n += 1;
		});
		subscribe(cause, () => removeEffect());

		transact(cause, () => {
			cause.n += 1;
		});

		expect(heard).toEqual([1]);
	});

	it("does not deliver a queued emission to a listener subscribed after it was queued", () => {
		const cause = createMutableState<Counter>({ n: 0 });
		const effect = createMutableState<Counter>({ n: 0 });
		const heard = new Array<number>();

		subscribe(effect, () => undefined);
		subscribe(cause, () => {
			transact(effect, () => {
				effect.n += 1;
			});
		});
		subscribe(cause, () => {
			subscribe(effect, () => heard.push(effect.n));
		});

		transact(cause, () => {
			cause.n += 1;
		});

		expect(heard).toEqual([]);
	});

	it("skips no sibling when a listener unsubscribes another mid-delivery", () => {
		const state = createMutableState<Counter>({ n: 0 });
		const heard = new Array<string>();

		let removeSecond = (): void => undefined;

		subscribe(state, () => {
			heard.push("first");
			removeSecond();
		});

		removeSecond = subscribe(state, () => heard.push("second"));

		subscribe(state, () => heard.push("third"));

		transact(state, () => {
			state.n += 1;
		});

		expect(heard).toEqual(["first", "second", "third"]);
	});

	it("flushes a listener's bare write after the delivery rather than inside it", async () => {
		const cause = createMutableState<Counter>({ n: 0 });
		const effect = createMutableState<Counter>({ n: 0 });
		const order = new Array<string>();

		subscribe(cause, () => {
			order.push("cause");
			effect.n += 1;
		});
		subscribe(effect, () => order.push("effect"));
		subscribe(cause, () => order.push("cause again"));

		transact(cause, () => {
			cause.n += 1;
		});

		expect(order).toEqual(["cause", "cause again"]);

		await Promise.resolve();
		await Promise.resolve();

		expect(order).toEqual(["cause", "cause again", "effect"]);
	});
});
