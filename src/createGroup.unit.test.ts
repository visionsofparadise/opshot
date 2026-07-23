import { createGroup } from "./createGroup";
import { createChannel } from "./createChannel";
import { createMutableState } from "./createMutableState";
import { isSameIdentity } from "./identity";
import { diffSnapshots } from "./ops/diff";
import { type Op } from "./ops/operation";
import { subscribe } from "./subscribe";
import { transact } from "./transact";

vi.mock(import("./ops/diff"), { spy: true });

interface Counter {
	count: number;
}

describe("createGroup", () => {
	it("hears every state it created, with the state reference and meta", () => {
		const group = createGroup();
		const emissions = new Array<{ state: object; ops: Array<Op>; meta: unknown }>();

		subscribe(group, (state, ops, meta) => {
			emissions.push({ state, ops: [...ops], meta });
		});

		const first = group.createState<Counter>({ count: 0 });
		const second = group.createState<Counter>({ count: 0 });

		transact(first, () => {
			first.count = 1;
		}, { transactionKey: "drag" });

		transact(second, () => {
			second.count = 2;
		});

		expect(emissions).toHaveLength(2);
		expect(emissions[0]?.state).toBe(first);
		expect(isSameIdentity(first, emissions[0]!.state)).toBe(true);
		expect(isSameIdentity(second, emissions[0]!.state)).toBe(false);
		expect(emissions[0]?.ops).toEqual([
			{ do: { op: "replace", path: ["count"], value: 1 }, undo: { op: "replace", path: ["count"], value: 0 } },
		]);
		expect(emissions[0]?.meta).toEqual({ transactionKey: "drag" });
		expect(emissions[1]?.state).toBe(second);
		expect(emissions[1]?.meta).toBeUndefined();
	});

	it("carries the live state object to the listener", () => {
		const group = createGroup();
		const emissions = new Array<object>();

		subscribe(group, (state) => {
			emissions.push(state);
		});

		const state = group.createState<Counter>({ count: 0 });

		transact(state, () => {
			state.count = 1;
		});

		expect(emissions[0]).toBe(state);
		expect((emissions[0] as Counter).count).toBe(1);
	});

	it("does not hear a standalone state", () => {
		const group = createGroup();
		const emissions = new Array<Array<Op>>();

		subscribe(group, (_state, ops) => {
			emissions.push([...ops]);
		});

		const standalone = createMutableState<Counter>({ count: 0 });
		const ownEmissions = new Array<Array<Op>>();

		subscribe(standalone, (ops) => {
			ownEmissions.push([...ops]);
		});

		transact(standalone, () => {
			standalone.count = 1;
		});

		expect(emissions).toHaveLength(0);
		expect(ownEmissions).toHaveLength(1);
	});

	it("isolates two groups", () => {
		const first = createGroup();
		const second = createGroup();
		const firstEmissions = new Array<Array<Op>>();
		const secondEmissions = new Array<Array<Op>>();

		subscribe(first, (_state, ops) => firstEmissions.push([...ops]));
		subscribe(second, (_state, ops) => secondEmissions.push([...ops]));

		const state = first.createState<Counter>({ count: 0 });

		transact(state, () => {
			state.count = 1;
		});

		expect(firstEmissions).toHaveLength(1);
		expect(secondEmissions).toHaveLength(0);
	});

	it("stops calling a listener after its remover runs", () => {
		const group = createGroup();
		const emissions = new Array<Array<Op>>();
		const remove = subscribe(group, (_state, ops) => {
			emissions.push([...ops]);
		});
		const state = group.createState<Counter>({ count: 0 });

		remove();
		transact(state, () => {
			state.count = 1;
		});

		expect(emissions).toHaveLength(0);
	});

	it("a group listener turns emission on for every state it created, and its removal turns it off", () => {
		const group = createGroup();
		const first = group.createState<Counter>({ count: 0 });
		const second = group.createState<Counter>({ count: 0 });

		vi.mocked(diffSnapshots).mockClear();

		transact(first, () => {
			first.count = 1;
		});

		expect(diffSnapshots).not.toHaveBeenCalled();

		const emissions = new Array<Array<Op>>();
		const remove = subscribe(group, (_state, ops) => {
			emissions.push([...ops]);
		});

		transact(first, () => {
			first.count = 2;
		});
		transact(second, () => {
			second.count = 5;
		});

		expect(diffSnapshots).toHaveBeenCalledTimes(2);
		expect(emissions).toHaveLength(2);

		remove();

		transact(first, () => {
			first.count = 3;
		});

		expect(diffSnapshots).toHaveBeenCalledTimes(2);
		expect(emissions).toHaveLength(2);
		expect(first.count).toBe(3);
	});

	it("calls a group listener first whenever it subscribed, then state listeners in subscription order", () => {
		const group = createGroup();
		const order = new Array<string>();
		const state = group.createState<Counter>({ count: 0 });

		subscribe(state, () => order.push("first"));
		subscribe(group, () => order.push("group"));
		subscribe(state, () => order.push("second"));

		transact(state, () => {
			state.count = 1;
		});

		expect(order).toEqual(["group", "first", "second"]);
	});

	it("delivers merged meta from a channel through a group subscriber", () => {
		const channel = createChannel<{ replay: boolean; transactionKey?: string }>({ replay: false });
		const group = createGroup();
		const heard = new Array<{ replay: boolean; transactionKey?: string }>();

		channel.subscribe(group, (_state, _ops, context) => {
			if (context.isTransaction) heard.push(context.meta);
		});

		const state = group.createState({ count: 0 });

		channel.transact(state, () => {
			state.count = 1;
		}, { transactionKey: "drag" });

		expect(heard).toEqual([{ replay: false, transactionKey: "drag" }]);
	});
});
