import { createGroup } from "./createGroup";
import { createChannel } from "./createChannel";
import { createMutableState } from "./createMutableState";
import { isSameIdentity } from "./identity";
import { diffObjects } from "./ops/diff";
import { type Operation } from "./ops/operation";
import { subscribe } from "./subscribe";
import { transact } from "./transact";

vi.mock(import("./ops/diff"), { spy: true });

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
		expect(emissions[0]?.ops).toEqual([
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

	it("does not hear a standalone state", () => {
		const group = createGroup();
		const emissions = new Array<Array<Operation>>();

		subscribe(group, (_state, ops) => {
			emissions.push([...ops]);
		});

		const standalone = createMutableState<Counter>({ count: 0 });
		const ownEmissions = new Array<Array<Operation>>();

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
		const firstEmissions = new Array<Array<Operation>>();
		const secondEmissions = new Array<Array<Operation>>();

		subscribe(first, (_state, ops) => firstEmissions.push([...ops]));
		subscribe(second, (_state, ops) => secondEmissions.push([...ops]));

		const state = first.createMutableState<Counter>({ count: 0 });

		transact(state, () => {
			state.count = 1;
		});

		expect(firstEmissions).toHaveLength(1);
		expect(secondEmissions).toHaveLength(0);
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

	it("a group listener turns emission on for every state it created, and its removal turns it off", () => {
		const group = createGroup();
		const first = group.createMutableState<Counter>({ count: 0 });
		const second = group.createMutableState<Counter>({ count: 0 });

		vi.mocked(diffObjects).mockClear();

		transact(first, () => {
			first.count = 1;
		});

		expect(diffObjects).not.toHaveBeenCalled();

		const emissions = new Array<Array<Operation>>();
		const remove = subscribe(group, (_state, ops) => {
			emissions.push([...ops]);
		});

		transact(first, () => {
			first.count = 2;
		});
		transact(second, () => {
			second.count = 5;
		});

		expect(diffObjects).toHaveBeenCalledTimes(2);
		expect(emissions).toHaveLength(2);

		remove();

		transact(first, () => {
			first.count = 3;
		});

		expect(diffObjects).toHaveBeenCalledTimes(2);
		expect(emissions).toHaveLength(2);
		expect(first.count).toBe(3);
	});

	it("calls a group listener first whenever it subscribed, then state listeners in subscription order", () => {
		const group = createGroup();
		const order = new Array<string>();
		const state = group.createMutableState<Counter>({ count: 0 });

		subscribe(state, () => order.push("first"));
		subscribe(group, () => order.push("group"));
		subscribe(state, () => order.push("second"));

		transact(state, () => {
			state.count = 1;
		});

		expect(order).toEqual(["group", "first", "second"]);
	});

	it("delivers parent before child before own listeners", () => {
		const parent = createGroup();
		const child = createGroup(parent);
		const order = new Array<string>();
		const state = child.createMutableState<Counter>({ count: 0 });

		subscribe(state, () => order.push("own"));
		subscribe(child, () => order.push("child"));
		subscribe(parent, () => order.push("parent"));

		transact(state, () => {
			state.count = 1;
		});

		expect(order).toEqual(["parent", "child", "own"]);
	});

	it("does not deliver a child group's state to a sibling group", () => {
		const parent = createGroup();
		const child = createGroup(parent);
		const sibling = createGroup(parent);
		const siblingEmissions = new Array<Array<Operation>>();

		subscribe(sibling, (_state, ops) => {
			siblingEmissions.push([...ops]);
		});

		const state = child.createMutableState<Counter>({ count: 0 });

		transact(state, () => {
			state.count = 1;
		});

		expect(siblingEmissions).toHaveLength(0);
	});

	it("delivers a three-tier state to the root group", () => {
		const root = createGroup();
		const mid = createGroup(root);
		const leaf = createGroup(mid);
		const order = new Array<string>();

		subscribe(root, () => order.push("root"));
		subscribe(mid, () => order.push("mid"));
		subscribe(leaf, () => order.push("leaf"));

		const state = leaf.createMutableState<Counter>({ count: 0 });

		transact(state, () => {
			state.count = 1;
		});

		expect(order).toEqual(["root", "mid", "leaf"]);
	});

	it("calls one listener function twice when subscribed to parent and child", () => {
		const parent = createGroup();
		const child = createGroup(parent);
		let callCount = 0;
		const listener = (): void => {
			callCount += 1;
		};

		subscribe(parent, listener);
		subscribe(child, listener);

		const state = child.createMutableState<Counter>({ count: 0 });

		transact(state, () => {
			state.count = 1;
		});

		expect(callCount).toBe(2);
	});

	it("runs every listener at every tier when one throws, and aggregates the failures", () => {
		const parent = createGroup();
		const child = createGroup(parent);
		const state = child.createMutableState<Counter>({ count: 0 });
		const called = new Array<string>();
		const parentFailure = new Error("parent listener failure");
		const childFailure = new Error("child listener failure");

		subscribe(parent, () => {
			called.push("parent");

			throw parentFailure;
		});
		subscribe(child, () => {
			called.push("child");

			throw childFailure;
		});
		subscribe(state, () => called.push("own"));

		let raised: unknown;

		try {
			transact(state, () => {
				state.count = 1;
			});
		} catch (error) {
			raised = error;
		}

		expect(called).toEqual(["parent", "child", "own"]);
		expect(raised).toBeInstanceOf(AggregateError);
		expect((raised as AggregateError).errors).toEqual([parentFailure, childFailure]);
	});

	it("delivers a queued emission to a group listener removed during the delivery that queued it", () => {
		const group = createGroup();
		const cause = group.createMutableState({ name: "cause", n: 0 });
		const effect = group.createMutableState({ name: "effect", n: 0 });
		const heard = new Array<string>();
		const removeGroup = subscribe(group, (state) => heard.push((state as { name: string }).name));

		subscribe(cause, () => {
			transact(effect, () => {
				effect.n += 1;
			});

			removeGroup();
		});

		transact(cause, () => {
			cause.n += 1;
		});

		expect(heard).toEqual(["cause", "effect"]);
	});

	it("delivers a frame's later record to a group listener removed while an earlier record delivered", () => {
		const group = createGroup();
		const transacted = group.createMutableState({ name: "transacted", n: 0 });
		const other = group.createMutableState({ name: "other", n: 0 });
		const heard = new Array<string>();
		const removeGroup = subscribe(group, (state) => heard.push((state as { name: string }).name));

		subscribe(transacted, () => removeGroup());

		transact(transacted, () => {
			transacted.n += 1;
			other.n += 1;
		});

		expect(heard).toEqual(["transacted", "other"]);
	});

	it("does not invert the inner tier when an outer-tier listener writes beneath it", () => {
		const parent = createGroup();
		const child = createGroup(parent);
		const cause = child.createMutableState({ name: "cause", n: 0 });
		const effect = child.createMutableState({ name: "effect", n: 0 });
		const heardByParent = new Array<string>();
		const heardByChild = new Array<string>();

		subscribe(parent, (state) => {
			heardByParent.push((state as { name: string }).name);

			if ((state as { name: string }).name !== "cause") return;

			transact(effect, () => {
				effect.n += 1;
			});
		});
		subscribe(child, (state) => heardByChild.push((state as { name: string }).name));

		transact(cause, () => {
			cause.n += 1;
		});

		expect(heardByParent).toEqual(["cause", "effect"]);
		expect(heardByChild).toEqual(["cause", "effect"]);
	});

	it("orders cause before effect at every tier of a three-tier chain", () => {
		const root = createGroup();
		const mid = createGroup(root);
		const leaf = createGroup(mid);
		const cause = leaf.createMutableState({ name: "cause", n: 0 });
		const effect = leaf.createMutableState({ name: "effect", n: 0 });
		const heard: Record<string, Array<string>> = { root: [], mid: [], leaf: [] };

		subscribe(root, (state) => {
			heard.root?.push((state as { name: string }).name);

			if ((state as { name: string }).name !== "cause") return;

			transact(effect, () => {
				effect.n += 1;
			});
		});
		subscribe(mid, (state) => heard.mid?.push((state as { name: string }).name));
		subscribe(leaf, (state) => heard.leaf?.push((state as { name: string }).name));

		transact(cause, () => {
			cause.n += 1;
		});

		expect(heard).toEqual({ root: ["cause", "effect"], mid: ["cause", "effect"], leaf: ["cause", "effect"] });
	});

	it("delivers merged meta from a channel through a group subscriber", () => {
		const channel = createChannel<{ replay: boolean; transactionKey?: string }>({ replay: false });
		const group = createGroup();
		const heard = new Array<{ replay: boolean; transactionKey?: string }>();

		channel.subscribe(group, (_state, _ops, context) => {
			if (context.isTransaction) heard.push(context.meta);
		});

		const state = group.createMutableState({ count: 0 });

		channel.transact(
			state,
			() => {
				state.count = 1;
			},
			{ transactionKey: "drag" },
		);

		expect(heard).toEqual([{ replay: false, transactionKey: "drag" }]);
	});
});
