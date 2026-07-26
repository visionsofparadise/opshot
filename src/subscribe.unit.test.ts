import { createChannel } from "./createChannel";
import { createGroup } from "./createGroup";
import { createMutableState } from "./createMutableState";
import { type Op } from "./ops/operation";
import { subscribe } from "./subscribe";
import { transact } from "./transact";

describe("subscribe", () => {
	it("subscribes and unsubscribes a state listener", () => {
		const state = createMutableState({ count: 0 });
		const heard = new Array<Array<Op>>();
		const stop = subscribe(state, (ops) => {
			heard.push([...ops]);
		});

		transact(state, () => {
			state.count = 1;
		});
		stop();
		transact(state, () => {
			state.count = 2;
		});

		expect(heard).toHaveLength(1);
		expect(state.count).toBe(2);
	});

	it("subscribes and unsubscribes a group listener", () => {
		const group = createGroup();
		const state = group.createMutableState({ count: 0 });
		const heard = new Array<object>();
		const stop = subscribe(group, (emitted) => {
			heard.push(emitted);
		});

		transact(state, () => {
			state.count = 1;
		});
		stop();
		transact(state, () => {
			state.count = 2;
		});

		expect(heard).toEqual([state]);
	});

	it("forwards raw meta without a provenance frame", () => {
		const state = createMutableState({ count: 0 });
		const heard = new Array<unknown>();

		subscribe(state, (_ops, meta) => {
			heard.push(meta);
		});

		transact(
			state,
			() => {
				state.count = 1;
			},
			{ a: 1 },
		);

		expect(heard).toEqual([{ a: 1 }]);
	});

	it("delivers a group listener the caller's meta verbatim, never the channel stamp", async () => {
		const channel = createChannel<{ actor: string }>();
		const group = createGroup();
		const heard = new Array<unknown>();

		subscribe(group, (_state, _ops, meta) => {
			heard.push(meta);
		});

		const state = group.createMutableState({ count: 0 });

		channel.transact(
			state,
			() => {
				state.count = 1;
			},
			{ actor: "matt" },
		);

		state.count = 2;
		await Promise.resolve();

		expect(heard).toEqual([{ actor: "matt" }, undefined]);
	});
});
