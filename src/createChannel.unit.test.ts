import { createChannel } from "./createChannel";
import { createGroup } from "./createGroup";
import { createMutableState } from "./createMutableState";
import { subscribe } from "./subscribe";
import { transact } from "./transact/transact";

describe("createChannel", () => {
	it("delivers total M on own-channel transactions with defaults merged", () => {
		const channel = createChannel<{ replay: boolean; transactionKey?: string }>({ replay: false });
		const state = createMutableState({ count: 0 });
		const heard = new Array<{ isTransaction: boolean; meta: unknown }>();

		channel.subscribe(state, (_ops, context) => {
			heard.push(context);
		});

		channel.transact(
			state,
			() => {
				state.count = 1;
			},
			{},
		);

		channel.transact(
			state,
			() => {
				state.count = 2;
			},
			{ replay: true, transactionKey: "drag" },
		);

		expect(heard).toEqual([
			{ isTransaction: true, meta: { replay: false } },
			{ isTransaction: true, meta: { replay: true, transactionKey: "drag" } },
		]);
	});

	it("marks bare writes and foreign-channel transacts as isTransaction false", async () => {
		const own = createChannel<{ actor: string }>();
		const foreign = createChannel<{ actor: string }>();
		const state = createMutableState({ count: 0 });
		const heard = new Array<{ isTransaction: boolean; meta: unknown }>();

		own.subscribe(state, (_ops, context) => {
			heard.push(context);
		});

		state.count = 1;
		await Promise.resolve();

		foreign.transact(
			state,
			() => {
				state.count = 2;
			},
			{ actor: "other" },
		);

		own.transact(
			state,
			() => {
				state.count = 3;
			},
			{ actor: "me" },
		);

		expect(heard).toEqual([
			{ isTransaction: false, meta: undefined },
			{ isTransaction: false, meta: { actor: "other" } },
			{ isTransaction: true, meta: { actor: "me" } },
		]);
	});

	it("plain subscribe receives unwrapped transport meta with no frame", () => {
		const channel = createChannel<{ actor: string }>();
		const state = createMutableState({ count: 0 });
		const heard = new Array<unknown>();

		subscribe(state, (_ops, meta) => {
			heard.push(meta);
		});

		channel.transact(
			state,
			() => {
				state.count = 1;
			},
			{ actor: "matt" },
		);

		transact(
			state,
			() => {
				state.count = 2;
			},
			{ plain: true },
		);

		expect(heard).toEqual([{ actor: "matt" }, { plain: true }]);
	});

	it("channel applyOperations transacts on the channel", () => {
		const channel = createChannel<{ replay: boolean }>({ replay: false });
		const state = createMutableState({ count: 0 });
		const ops: Array<import("./ops/operation").Operation> = [];

		const unsub = channel.subscribe(state, (delivered) => {
			ops.push(...delivered);
		});

		channel.transact(state, () => {
			state.count = 5;
		});
		unsub();

		const replay = createMutableState({ count: 0 });
		const replayHeard = new Array<unknown>();

		channel.subscribe(replay, (_ops, context) => {
			if (context.isTransaction) replayHeard.push(context.meta);
		});

		channel.applyOperations(replay, ops, "do", {});

		expect(replay.count).toBe(5);
		expect(replayHeard).toEqual([{ replay: false }]);
	});

	it("works with a group subscriber", () => {
		const channel = createChannel<{ tag: string }>();
		const group = createGroup();
		const heard = new Array<{ state: object; meta: unknown }>();

		channel.subscribe(group, (state, _ops, context) => {
			if (context.isTransaction) heard.push({ state, meta: context.meta });
		});

		const state = group.createMutableState({ count: 0 });

		channel.transact(
			state,
			() => {
				state.count = 1;
			},
			{ tag: "g" },
		);

		expect(heard).toEqual([{ state, meta: { tag: "g" } }]);
	});

	it("plain subscriber receives the caller's meta bag by identity", () => {
		const channel = createChannel<{ actor: string }>();
		const state = createMutableState({ count: 0 });
		const bag = { actor: "matt" };
		const heard = new Array<unknown>();

		subscribe(state, (_ops, meta) => {
			heard.push(meta);
		});

		channel.transact(
			state,
			() => {
				state.count = 1;
			},
			bag,
		);

		expect(heard).toHaveLength(1);
		expect(heard[0]).toBe(bag);
	});

	it("a dirty covering record reaches the channel as a Write then a Transaction write", () => {
		const channel = createChannel<{ actor: string }>();
		const state = createMutableState({ a: { n: 0 }, bare: 0 });
		const heard = new Array<{ isTransaction: boolean; meta: unknown }>();

		channel.subscribe(state, (_ops, context) => {
			heard.push(context);
		});

		state.bare = 1;

		channel.transact(
			state,
			() => {
				state.a.n = 1;
				state.bare = 2;
			},
			{ actor: "me" },
		);

		expect(heard).toEqual([
			{ isTransaction: false, meta: undefined },
			{ isTransaction: true, meta: { actor: "me" } },
		]);
	});
});
