import { createMutableState } from "../createMutableState";
import { subscribe } from "../subscribe";
import { transact } from "../transact";
import { applyOperations } from "./applyOperations";
import { type Operation } from "./operation";

describe("applyOperations: replay cost", () => {
	it("replays a deep spine without the per-node redundancy a star never paid", () => {
		const buildSpine = (depth: number): { child?: unknown } => {
			const root: { child?: unknown } = {};
			let node = root;

			for (let level = 0; level < depth; level += 1) {
				const next: { child?: unknown; n: number } = { n: level };

				node.child = next;
				node = next;
			}

			return root;
		};

		const buildStar = (count: number): Record<string, unknown> => {
			const root: Record<string, unknown> = {};

			for (let index = 0; index < count; index += 1) root[`c${index}`] = { n: index };

			return root;
		};

		const undoCost = (shape: object): number => {
			const state = createMutableState<{ tree: object }>({ tree: shape });
			const recorded = new Array<Operation>();

			subscribe(state, (ops) => recorded.push(...ops));

			transact(state, () => {
				state.tree = {};
			});

			const undo = recorded.map((op) => op.undo).reverse();
			const started = performance.now();

			applyOperations(state, undo);

			return performance.now() - started;
		};

		const best = (build: () => object): number => {
			let lowest = Number.POSITIVE_INFINITY;

			for (let run = 0; run < 5; run += 1) lowest = Math.min(lowest, undoCost(build()));

			return Math.max(lowest, 0.05);
		};

		const star = best(() => buildStar(300));
		const spine = best(() => buildSpine(300));

		expect(spine / star).toBeLessThan(10);
	});
});
