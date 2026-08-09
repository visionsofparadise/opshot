import { createChannel } from "./createChannel";
import { createGroup } from "./createGroup";
import { createMutableState } from "./createMutableState";
import { applyOperations } from "./ops/applyOperations";
import { type Operation } from "./ops/operation";
import { subscribe, type EmissionContext } from "./subscribe";
import { transact } from "./transact";
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

	it("subscribing the same function twice to a state is one subscription", () => {
		const state = createMutableState({ count: 0 });
		const heard = new Array<ReadonlyArray<Operation>>();
		const listener = (ops: ReadonlyArray<Operation>): void => {
			heard.push(ops);
		};

		subscribe(state, listener);
		const stop = subscribe(state, listener);

		transact(state, () => {
			state.count = 1;
		});

		expect(heard).toHaveLength(1);

		stop();
		transact(state, () => {
			state.count = 2;
		});

		expect(heard).toHaveLength(1);
	});

	it("subscribing the same function twice to a group is one subscription", () => {
		const group = createGroup();
		const state = group.createMutableState({ count: 0 });
		const heard = new Array<object>();
		const listener = (emitted: object): void => {
			heard.push(emitted);
		};

		subscribe(group, listener);
		const stop = subscribe(group, listener);

		transact(state, () => {
			state.count = 1;
		});

		expect(heard).toEqual([state]);

		stop();
		transact(state, () => {
			state.count = 2;
		});

		expect(heard).toEqual([state]);
	});

	it("the same function through two channels delivers once per channel frame; unsubscribing one leaves the other", () => {
		const state = createMutableState({ count: 0 });
		const a = createChannel<{ tag: string }>({ tag: "a" });
		const b = createChannel<{ tag: string }>({ tag: "b" });
		const heard = new Array<string>();
		const listener = (_ops: ReadonlyArray<Operation>, context: EmissionContext<{ tag: string }>): void => {
			heard.push(context.isTransaction ? context.meta.tag : "foreign");
		};

		const stopA = a.subscribe(state, listener);

		b.subscribe(state, listener);

		a.transact(state, () => {
			state.count = 1;
		});

		expect(heard).toEqual(["a", "foreign"]);

		heard.length = 0;
		b.transact(state, () => {
			state.count = 2;
		});

		expect(heard).toEqual(["foreign", "b"]);

		heard.length = 0;
		stopA();
		b.transact(state, () => {
			state.count = 3;
		});

		expect(heard).toEqual(["b"]);
	});

	it("delivers in registration order across mixed plain and channel subscriptions", () => {
		const state = createMutableState({ count: 0 });
		const channel = createChannel();
		const order = new Array<string>();
		const plainA = (): void => {
			order.push("A");
		};
		const channelB = (): void => {
			order.push("B");
		};
		const plainC = (): void => {
			order.push("C");
		};

		subscribe(state, plainA);
		channel.subscribe(state, channelB);
		subscribe(state, plainC);

		transact(state, () => {
			state.count = 1;
		});

		expect(order).toEqual(["A", "B", "C"]);
	});

	it("node subscription delivers node-relative paths and is silent for sibling writes", async () => {
		const state = createMutableState({ a: { x: 0 }, b: { y: 0 } });
		const nodeHeard = new Array<ReadonlyArray<Operation>>();
		const rootHeard = new Array<ReadonlyArray<Operation>>();

		subscribe(state.a, (ops) => {
			nodeHeard.push([...ops]);
		});
		subscribe(state, (ops) => {
			rootHeard.push([...ops]);
		});

		state.a.x = 1;
		await Promise.resolve();

		expect(nodeHeard.map(shapeOps)).toEqual([
			[{ do: { verb: "assign", path: ["x"], value: 1 }, undo: { verb: "assign", path: ["x"], value: 0 } }],
		]);
		expect(rootHeard.map(shapeOps)).toEqual([
			[
				{
					do: { verb: "assign", path: ["a", "x"], value: 1 },
					undo: { verb: "assign", path: ["a", "x"], value: 0 },
				},
			],
		]);

		nodeHeard.length = 0;
		rootHeard.length = 0;

		state.b.y = 2;
		await Promise.resolve();

		expect(nodeHeard).toEqual([]);
		expect(rootHeard.map(shapeOps)).toEqual([
			[
				{
					do: { verb: "assign", path: ["b", "y"], value: 2 },
					undo: { verb: "assign", path: ["b", "y"], value: 0 },
				},
			],
		]);
	});

	it("unsubscribing a node listener leaves the root listener intact", async () => {
		const state = createMutableState({ a: { x: 0 }, b: { y: 0 } });
		const rootHeard = new Array<ReadonlyArray<Operation>>();
		const stopNode = subscribe(state.a, () => undefined);

		subscribe(state, (ops) => {
			rootHeard.push([...ops]);
		});

		stopNode();

		state.a.x = 1;
		await Promise.resolve();

		expect(rootHeard.map(shapeOps)).toEqual([
			[
				{
					do: { verb: "assign", path: ["a", "x"], value: 1 },
					undo: { verb: "assign", path: ["a", "x"], value: 0 },
				},
			],
		]);
	});

	it("delivers a transaction below the root to a group listener and to its channel", () => {
		const channel = createChannel<{ replay: boolean }>({ replay: false });
		const group = createGroup();
		const state = group.createMutableState({ a: { n: 0 } });
		const plainHeard = new Array<unknown>();
		const channelHeard = new Array<EmissionContext<{ replay: boolean }>>();

		subscribe(group, (_state, _ops, meta) => plainHeard.push(meta));
		channel.subscribe(group, (_state, _ops, context) => channelHeard.push(context));

		channel.transact(
			state.a,
			() => {
				state.a.n = 1;
			},
			{ replay: true },
		);

		expect(plainHeard).toEqual([{ replay: true }]);
		expect(channelHeard).toEqual([{ isTransaction: true, meta: { replay: true } }]);
	});

	it("carries an applyOperations replay flag to a subscriber below the applied node", () => {
		const state = createMutableState({ a: { n: 0 } });
		const recorded = new Array<Operation>();
		const stopRecording = subscribe(state, (ops) => recorded.push(...ops));

		transact(state, () => {
			state.a.n = 1;
		});
		stopRecording();

		const heard = new Array<unknown>();

		subscribe(state.a, (_ops, meta) => heard.push(meta));

		applyOperations(state, recorded, "undo", { replay: true });

		expect(heard).toEqual([{ replay: true }]);
		expect(state.a.n).toBe(0);
	});

	it("keeps an applyOperations replay flag off the enclosing transaction it runs inside", () => {
		const state = createMutableState({ a: { n: 0 }, top: 0 });
		const recorded = new Array<Operation>();
		const stopRecording = subscribe(state.a, (ops) => recorded.push(...ops));

		transact(state, () => {
			state.a.n = 1;
		});
		stopRecording();

		const rootHeard = new Array<unknown>();
		const nodeHeard = new Array<unknown>();

		subscribe(state, (_ops, meta) => rootHeard.push(meta));
		subscribe(state.a, (_ops, meta) => nodeHeard.push(meta));

		transact(
			state,
			() => {
				applyOperations(state.a, recorded, "undo", { replay: true });
				state.top = 1;
			},
			{ transactionKey: "user-drag" },
		);

		expect(rootHeard).toEqual([{ transactionKey: "user-drag" }]);
		expect(nodeHeard).toEqual([{ replay: true }]);
	});

	it("refuses applyOperations on the node an enclosing transact already holds", () => {
		const state = createMutableState({ n: 0 });
		const recorded = new Array<Operation>();

		subscribe(state, (ops) => recorded.push(...ops));

		transact(state, () => {
			state.n = 1;
		});

		expect(() =>
			transact(state, () => {
				applyOperations(state, recorded, "undo", { replay: true });
			}),
		).toThrow("opshot: nested transact on the same state");
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

	it("invokes a synchronous emitOn once per window rather than once per write", async () => {
		let invocations = 0;
		const state = createMutableState(
			{ n: 0 },
			{
				emitOn: (flush) => {
					invocations += 1;
					flush();
				},
			},
		);
		const heard = new Array<Array<Operation>>();

		subscribe(state, (ops) => heard.push([...ops]));

		state.n = 1;
		state.n = 2;
		state.n = 3;

		expect(invocations).toBe(0);
		expect(heard).toHaveLength(0);

		await Promise.resolve();

		expect(invocations).toBe(1);
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

	it("throws when the target is a scalar field", () => {
		const state = createMutableState({ a: { x: 0 } });

		expect(() => {
			subscribe(state.a.x as unknown as object, () => undefined);
		}).toThrow("opshot: expected a state object");
	});
});
