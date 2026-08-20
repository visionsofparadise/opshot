import { createChannel } from "./createChannel";
import { createGroup } from "./createGroup";
import { createMutableState } from "./createMutableState";
import { type Operation } from "./ops/operation";
import { shapeOps } from "./ops/operationShape";

describe("createChannel", () => {
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

	it("a group subscriber on a channel receives the state, its ops, and channel-merged meta", () => {
		const channel = createChannel<{ replay: boolean; tag?: string }>({ replay: false });
		const group = createGroup();
		const heard = new Array<{ state: object; ops: Array<Operation>; context: unknown }>();

		channel.subscribe(group, (state, ops, context) => {
			heard.push({ state, ops: [...ops], context });
		});

		const state = group.createMutableState({ count: 0 });

		channel.transact(
			state,
			() => {
				state.count = 1;
			},
			{ tag: "g" },
		);

		expect(heard).toHaveLength(1);
		expect(heard[0]?.state).toBe(state);
		expect(heard[0]?.context).toEqual({ isTransaction: true, meta: { replay: false, tag: "g" } });
		expect(shapeOps(heard[0]?.ops ?? [])).toEqual([
			{ do: { verb: "assign", path: ["count"], value: 1 }, undo: { verb: "assign", path: ["count"], value: 0 } },
		]);
	});

	it("channel applyOperations replaying a serialized stream reports isTransaction true with channel defaults merged", () => {
		const channel = createChannel<{ replay: boolean }>({ replay: false });
		const state = createMutableState({ count: 0 });
		const ops: Array<Operation> = [];

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

		channel.applyOperations(replay, JSON.parse(JSON.stringify(ops)) as Array<Operation>, "do", {});

		expect(replay.count).toBe(5);
		expect(replayHeard).toEqual([{ replay: false }]);
	});

	it("a foreign channel's transact reaches this channel's subscriber as isTransaction false", () => {
		const own = createChannel<{ actor: string }>();
		const foreign = createChannel<{ actor: string }>();
		const state = createMutableState({ count: 0 });
		const heard = new Array<{ isTransaction: boolean; meta: unknown }>();

		own.subscribe(state, (_ops, context) => {
			heard.push(context);
		});

		foreign.transact(
			state,
			() => {
				state.count = 1;
			},
			{ actor: "other" },
		);

		own.transact(
			state,
			() => {
				state.count = 2;
			},
			{ actor: "me" },
		);

		expect(heard).toEqual([
			{ isTransaction: false, meta: { actor: "other" } },
			{ isTransaction: true, meta: { actor: "me" } },
		]);
	});
});
