import { createGroup } from "../createGroup";
import { getGroupListeners } from "../createGroup";
import { createMutableState } from "../createMutableState";
import { diffSnapshots } from "../ops/diff";
import { type Op } from "../ops/operation";
import { subscribe } from "../subscribe";
import { emitBareFlush, mintGroupedEmitter } from "./emitterBare";
import { getOrCreateEmitter } from "./emitterRegistry";

type CyclicNode = { n: number; self?: CyclicNode };

vi.mock(import("../ops/diff"), { spy: true });

describe("emitterBare", () => {
	it("mintGroupedEmitter arms at mint and stays quiescent without listeners", async () => {
		const group = createGroup();
		const listeners = getGroupListeners(group);
		const state = createMutableState({ count: 0 });
		const record = mintGroupedEmitter(state, listeners);

		expect(record.disarm).toBeTypeOf("function");

		vi.mocked(diffSnapshots).mockClear();

		state.count = 1;

		await Promise.resolve();

		expect(diffSnapshots).not.toHaveBeenCalled();
		expect(state.count).toBe(1);

		const heard = new Array<ReadonlyArray<Op>>();

		subscribe(group, (_state, ops) => {
			heard.push(ops);
		});

		state.count = 2;

		await Promise.resolve();

		expect(heard).toEqual([
			[{ do: { op: "replace", path: ["count"], value: 2 }, undo: { op: "replace", path: ["count"], value: 1 } }],
		]);
	});

	it("emitBareFlush is a no-op when current equals lastReported", () => {
		const state = createMutableState({ count: 0 });
		const record = getOrCreateEmitter(state);

		vi.mocked(diffSnapshots).mockClear();

		emitBareFlush(record.target);

		expect(diffSnapshots).not.toHaveBeenCalled();
	});

	it("augments a bare-flush cycle error naming transact as the catchable lane", async () => {
		const state = createMutableState<{ node: CyclicNode }>({ node: { n: 1 } });

		subscribe(state, () => undefined);

		state.node.self = state.node;
		await Promise.resolve();
		await Promise.resolve();

		state.node.n = 2;

		expect(() => {
			emitBareFlush(state);
		}).toThrow(/transact/);

		await Promise.resolve();
		await Promise.resolve();
	});
});
