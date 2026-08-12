import { createMutableState } from "../createMutableState";
import { subscribe } from "../subscribe";
import { transact } from "../transact";

interface Scenario {
	readonly name: string;
	readonly run: (state: MutableFixture) => void;
}

interface MutableFixture {
	hub: { h: number; [key: string]: unknown };
	x: { y: { k: number; [key: string]: unknown }; [key: string]: unknown };
	list: Array<unknown>;
	misc: { deep?: { z: number }; [key: string]: unknown };
	n: number;
	[key: string]: unknown;
}

const createFixture = (): MutableFixture => ({
	hub: { h: 1 },
	x: { y: { k: 2 } },
	list: [1, 2, 3],
	misc: { deep: { z: 9 } },
	n: 0,
});

const signatureOf = (root: object): string => {
	const canonical = new Map<object, string>();
	const lines = new Array<string>();

	const visit = (node: object, path: string): void => {
		for (const key of Object.keys(node)
			.filter((candidate) => candidate !== "__proto__")
			.sort()) {
			const descriptor = Reflect.getOwnPropertyDescriptor(node, key);

			if (!descriptor || !("value" in descriptor)) continue;

			const value: unknown = descriptor.value;
			const childPath = `${path}/${key}`;

			if (value !== null && typeof value === "object") {
				const seenAt = canonical.get(value);

				if (seenAt !== undefined) {
					lines.push(`${childPath} -> @${seenAt}`);

					continue;
				}

				canonical.set(value, childPath);
				lines.push(`${childPath} -> ${Array.isArray(value) ? "[]" : "{}"}`);
				visit(value, childPath);
			} else lines.push(`${childPath} = ${JSON.stringify(value)}`);
		}
	};

	canonical.set(root, "");
	visit(root, "");

	return lines.sort().join("\n");
};

const scenarios: ReadonlyArray<Scenario> = [
	{ name: "alias-hub-to-new", run: (state) => void (state.alias = state.hub) },
	{ name: "alias-hub-into-x", run: (state) => void (state.x.hubRef = state.hub) },
	{ name: "alias-deep", run: (state) => void (state.aliasDeep = state.misc.deep) },
	{ name: "fresh-embed", run: (state) => void (state.wrap = { inner: { a: state.hub } }) },
	{ name: "replace-x-embed", run: (state) => void (state.x = { y: state.x.y, ref: state.hub }) },
	{
		name: "move-hub",
		run: (state) => {
			const held = state.hub;

			delete (state as Record<string, unknown>).hub;
			state.moved = held;
		},
	},
	{
		name: "move-deep",
		run: (state) => {
			const held = state.misc.deep;

			delete state.misc.deep;
			state.x.moved = held;
		},
	},
	{
		name: "new-then-alias",
		run: (state) => {
			state.fresh = { q: 1 };
			state.freshAlias = state.fresh;
		},
	},
	{
		name: "new-nested-then-alias",
		run: (state) => {
			state.x.fresh = { q: 1 };
			state.nestedAlias = state.x.fresh;
		},
	},
	{ name: "cycle-self", run: (state) => void (state.misc.self = state.misc) },
	{ name: "cycle-back", run: (state) => void (state.x.y.back = state.x) },
	{ name: "array-push-alias", run: (state) => void state.list.push(state.hub) },
	{ name: "array-splice-alias", run: (state) => void state.list.splice(1, 1, state.misc.deep) },
	{ name: "object-assign-alias", run: (state) => void Object.assign(state.x, { assigned: state.hub }) },
	{
		name: "delete-readd",
		run: (state) => {
			const held = state.hub;

			delete (state as Record<string, unknown>).hub;
			state.hub = held;
		},
	},
	{ name: "delete-misc-deep", run: (state) => void delete state.misc.deep },
	{
		name: "two-routes-then-delete-one",
		run: (state) => {
			state.first = state.hub;
			state.second = state.hub;
			delete (state as Record<string, unknown>).hub;
		},
	},
	{
		name: "double-route-parent",
		run: (state) => {
			state.parentAlias = state.x.y;
			state.x.y.child = state.misc.deep;
		},
	},
	{ name: "nested-replace", run: (state) => void (state.misc = { deep: state.misc.deep, extra: 1 }) },
	{ name: "scalar", run: (state) => void (state.n += 1) },
	{
		name: "partial-then-throw",
		run: (state) => {
			state.partial = state.hub;
			state.x.y.partial = state.misc.deep;

			throw new Error("rollback-fidelity-partial");
		},
	},
];

const sequencesOf = (limit: number): ReadonlyArray<ReadonlyArray<Scenario>> => {
	const sequences = new Array<ReadonlyArray<Scenario>>();

	for (const first of scenarios) {
		sequences.push([first]);

		for (const second of scenarios) {
			sequences.push([first, second]);

			if (sequences.length >= limit) return sequences;
		}
	}

	return sequences;
};

describe("transact: rollback fidelity", () => {
	it("restores the graph and emits nothing for every aborted mutation sequence", async () => {
		const sequences = sequencesOf(440);
		const divergences = new Array<string>();
		const emissions = new Array<string>();
		let partialFailures = 0;

		for (const sequence of sequences) {
			const state = createMutableState<MutableFixture>(createFixture());
			const baseline = signatureOf(state);
			const heard = new Array<unknown>();
			const unsubscribe = subscribe(state, (ops) => heard.push(...ops));
			const name = sequence.map((scenario) => scenario.name).join("+");

			try {
				transact(state, () => {
					for (const scenario of sequence) scenario.run(state);

					throw new Error("rollback-fidelity-abort");
				});

				divergences.push(`${name} => transaction did not propagate its throw`);
			} catch (error) {
				if (!(error as Error).message.includes("rollback-fidelity-abort")) partialFailures += 1;
			}

			await Promise.resolve();
			await Promise.resolve();
			unsubscribe();

			if (signatureOf(state) !== baseline) divergences.push(`${name} => rollback diverged from baseline`);

			if (heard.length > 0) emissions.push(`${name} => emitted ${heard.length} ops despite rollback`);
		}

		expect(divergences).toEqual([]);
		expect(emissions).toEqual([]);
		expect(partialFailures).toBeGreaterThan(0);
	});
});
