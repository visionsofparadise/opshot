import { createChannel } from "./createChannel";
import { createMutableState } from "./createMutableState";
import { type Operation } from "./ops/operation";
import { subscribe } from "./subscribe";
import { transact } from "./transact/transact";
import { shapeOps } from "./ops/operationShape";

describe("subscribe", () => {
	it("subscribes and unsubscribes a state listener", () => {
		const state = createMutableState({ count: 0 });
		const heard = new Array<Array<Operation>>();
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

	it("bounds bare writes to one net diff per window under the default latch", async () => {
		const state = createMutableState({ n: 0 });
		const heard = new Array<Array<Operation>>();

		subscribe(state, (ops) => heard.push([...ops]));

		state.n = 1;
		state.n = 2;
		state.n = 3;

		expect(heard).toHaveLength(0);

		await Promise.resolve();

		expect(heard.map(shapeOps)).toEqual([
			[{ do: { verb: "assign", path: ["n"], value: 3 }, undo: { verb: "assign", path: ["n"], value: 0 } }],
		]);
	});

	it("invokes a deferring emitOn once per window and delivers only when it flushes", async () => {
		const scheduled = new Array<() => void>();
		const state = createMutableState({ n: 0 }, { emitOn: (flush) => scheduled.push(flush) });
		const heard = new Array<Array<Operation>>();

		subscribe(state, (ops) => heard.push([...ops]));

		state.n = 1;
		state.n = 2;
		state.n = 3;

		expect(scheduled).toHaveLength(0);

		await Promise.resolve();

		expect(scheduled).toHaveLength(1);
		expect(heard).toHaveLength(0);

		for (const flush of scheduled) flush();

		expect(heard.map(shapeOps)).toEqual([
			[{ do: { verb: "assign", path: ["n"], value: 3 }, undo: { verb: "assign", path: ["n"], value: 0 } }],
		]);
	});

	it("a channel transact with no meta delivers the channel defaults verbatim", () => {
		const defaults = { actor: "default", role: "writer" };
		const channel = createChannel<{ actor: string; role: string }>(defaults);
		const state = createMutableState({ count: 0 });
		const heard = new Array<unknown>();

		channel.subscribe(state, (_ops, context) => {
			heard.push(context);
		});

		channel.transact(state, () => {
			state.count = 1;
		});

		expect(heard).toEqual([{ isTransaction: true, meta: { actor: "default", role: "writer" } }]);
	});
});
