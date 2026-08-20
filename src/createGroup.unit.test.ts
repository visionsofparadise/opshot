import { createGroup } from "./createGroup";
import { isSameIdentity } from "./identity";
import { type Operation } from "./ops/operation";
import { subscribe } from "./subscribe";
import { transact } from "./transact/transact";
import { shapeOps } from "./ops/operationShape";

interface Counter {
	count: number;
}

describe("createGroup", () => {
	it("hears every state it created, with the state reference and meta", () => {
		const group = createGroup();
		const emissions = new Array<{ state: object; ops: Array<Operation>; meta: unknown }>();

		subscribe(group, (state, ops, meta) => {
			emissions.push({ state, ops: [...ops], meta });
		});

		const first = group.createMutableState<Counter>({ count: 0 });
		const second = group.createMutableState<Counter>({ count: 0 });

		transact(
			first,
			() => {
				first.count = 1;
			},
			{ transactionKey: "drag" },
		);

		transact(second, () => {
			second.count = 2;
		});

		expect(emissions).toHaveLength(2);
		expect(emissions[0]?.state).toBe(first);
		expect(isSameIdentity(first, emissions[0]!.state)).toBe(true);
		expect(isSameIdentity(second, emissions[0]!.state)).toBe(false);
		expect(shapeOps(emissions[0]?.ops ?? [])).toEqual([
			{ do: { verb: "assign", path: ["count"], value: 1 }, undo: { verb: "assign", path: ["count"], value: 0 } },
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

		const state = group.createMutableState<Counter>({ count: 0 });

		transact(state, () => {
			state.count = 1;
		});

		expect(emissions[0]).toBe(state);
		expect((emissions[0] as Counter).count).toBe(1);
	});

	it("stops calling a listener after its remover runs", () => {
		const group = createGroup();
		const emissions = new Array<Array<Operation>>();
		const remove = subscribe(group, (_state, ops) => {
			emissions.push([...ops]);
		});
		const state = group.createMutableState<Counter>({ count: 0 });

		remove();
		transact(state, () => {
			state.count = 1;
		});

		expect(emissions).toHaveLength(0);
	});
});
