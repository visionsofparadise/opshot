import { createChannel } from "./createChannel";
import { createMutableState } from "./createMutableState";

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
});
