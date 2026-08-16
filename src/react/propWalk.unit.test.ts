import { createElement } from "react";
import { createMutableState } from "../createMutableState";
import { ignore } from "../ignore";
import { TrackedMap } from "../tracked/trackedMap";
import { TrackedSet } from "../tracked/trackedSet";
import { unsafeTrack } from "../unsafeTrack";
import { discoverStateKeys, substituteStates, type SubstitutionResult } from "./propWalk";

class CleanHolder {
	inner: unknown;

	constructor(inner: unknown) {
		this.inner = inner;
	}
}

class PrivateHolder {
	#secret = 1;
	inner: unknown;

	constructor(inner: unknown) {
		this.inner = inner;
	}

	reveal(): number {
		return this.#secret;
	}
}

class ArraySubclass extends Array<unknown> {}

interface VisitCounter {
	readonly instrument: <T extends object>(target: T) => T;
	readonly countVisits: () => number;
}

const createState = (): object => createMutableState({ count: 0 });

const wrapSource = (source: object): object => ({ wrapper: source });

const discoveredKeys = (container: object): Array<string> => [...discoverStateKeys(container)].sort();

const reachesState = (containers: Record<string, object>): Record<string, boolean> =>
	Object.fromEntries(
		Object.entries(containers).map(([name, container]) => [name, discoverStateKeys({ container }).size > 0]),
	);

const nestDeeply = (depth: number, leaf: unknown): Record<string, unknown> => {
	let current: Record<string, unknown> = { child: leaf };

	for (let level = 1; level < depth; level += 1) current = { child: current };

	return current;
};

const createVisitCounter = (): VisitCounter => {
	let visits = 0;

	return {
		instrument: (target) =>
			new Proxy(target, {
				ownKeys: (proxied) => {
					visits += 1;

					return Reflect.ownKeys(proxied);
				},
			}),
		countVisits: () => visits,
	};
};

describe("discoverStateKeys", () => {
	it("finds a state nested deeper than the retired depth cap", () => {
		const state = createState();

		expect(discoveredKeys(nestDeeply(15, state))).toEqual(["child"]);
		expect(discoveredKeys(nestDeeply(15, { leaf: 1 }))).toEqual([]);
	});

	it("finds every state at mixed depths and counts no key that leads to none", () => {
		const first = createState();
		const second = createState();
		const third = createState();
		const root = { first, nested: { second }, list: [0, { third }], stateless: { count: 1 } };

		expect(discoveredKeys(root)).toEqual(["first", "list", "nested"]);
		expect(discoveredKeys(root.nested)).toEqual(["second"]);
		expect(discoveredKeys(root.list)).toEqual(["1"]);
	});

	it("finds a state inside every container kind the data definition covers", () => {
		const state = createState();
		const nullPrototype = Object.assign(Object.create(null) as Record<string, unknown>, { inner: state });

		expect(
			reachesState({
				plainObject: { inner: state },
				plainArray: [state],
				nullPrototypeObject: nullPrototype,
				cleanClass: new CleanHolder(state),
				trackedMap: new TrackedMap<string, object>([["key", state]]),
				trackedSet: new TrackedSet<object>([state]),
			}),
		).toEqual({
			plainObject: true,
			plainArray: true,
			nullPrototypeObject: true,
			cleanClass: true,
			trackedMap: true,
			trackedSet: true,
		});
	});

	it("leaves a container outside the data definition unsearched, without throwing", () => {
		const state = createState();
		const arraySubclass = new ArraySubclass();

		arraySubclass.push(state);

		expect(
			reachesState({
				rawMap: Object.assign(new Map([["key", state]]), { inner: state }),
				rawSet: Object.assign(new Set([state]), { inner: state }),
				date: Object.assign(new Date(), { inner: state }),
				regExp: Object.assign(/probe/, { inner: state }),
				promise: Object.assign(Promise.resolve(), { inner: state }),
				typedArray: Object.assign(new Uint8Array(1), { inner: state }),
				arraySubclass,
				privateClass: new PrivateHolder(state),
			}),
		).toEqual({
			rawMap: false,
			rawSet: false,
			date: false,
			regExp: false,
			promise: false,
			typedArray: false,
			arraySubclass: false,
			privateClass: false,
		});
	});

	it("finds a state inside an unsafeTrack'd dangerous-kind container", () => {
		const state = createState();

		expect(reachesState({ unsafeTrackedPrivateClass: unsafeTrack(new PrivateHolder(state)) })).toEqual({
			unsafeTrackedPrivateClass: true,
		});
	});

	it("leaves a frozen nested container unsearched", () => {
		const state = createState();

		expect(discoveredKeys(Object.freeze({ inner: state }))).toEqual([]);
	});

	it("leaves an ignore()d container unsearched", () => {
		const state = createState();

		expect(discoveredKeys({ container: ignore({ inner: state }) })).toEqual([]);
	});

	it("finds a state on an array's own non-index property", () => {
		const state = createState();
		const list: Array<number> = [0, 1];

		Object.assign(list, { meta: state });

		expect(discoveredKeys(list)).toEqual(["meta"]);
	});

	it("skips symbol keys, non-enumerable properties and accessors, and never invokes a getter", () => {
		const state = createState();
		const symbolKey = Symbol("concealed");
		const root: Record<PropertyKey, unknown> = { visible: 1 };
		let getterCalls = 0;

		root[symbolKey] = state;

		Object.defineProperty(root, "hidden", { value: state, enumerable: false, configurable: true });
		Object.defineProperty(root, "derived", {
			get: () => {
				getterCalls += 1;

				return state;
			},
			enumerable: true,
			configurable: true,
		});

		expect(discoveredKeys(root)).toEqual([]);
		expect(getterCalls).toBe(0);
	});

	it("leaves a React element unsearched", () => {
		const state = createState();

		expect(discoveredKeys({ element: createElement("div", { inner: state }) })).toEqual([]);
	});

	it("terminates on a self cycle and counts the cycle key that leads back to the state", () => {
		const state = createState();
		const node: Record<string, unknown> = { inner: state };

		node.self = node;

		expect(discoveredKeys(node)).toEqual(["inner", "self"]);
	});

	it("terminates on a deep cycle holding no state", () => {
		const child: Record<string, unknown> = { count: 1 };
		const root: Record<string, unknown> = { child };

		child.back = root;

		expect(discoveredKeys(root)).toEqual([]);
		expect(discoveredKeys(child)).toEqual([]);
	});

	it("finds a state inside a cycle through both entry points into it", () => {
		const state = createState();
		const first: Record<string, unknown> = { inner: { state } };
		const second: Record<string, unknown> = { first };

		first.second = second;

		expect(discoveredKeys({ first, second })).toEqual(["first", "second"]);
	});

	it("finds a state reachable only through a back-edge, which a first-visit walk under-reports", () => {
		const state = createState();
		const first: Record<string, unknown> = { state };
		const second: Record<string, unknown> = { first };

		first.second = second;

		expect(discoveredKeys(first)).toEqual(["second", "state"]);
		expect(discoveredKeys(second)).toEqual(["first"]);
	});

	it("visits an aliased node once and counts both routes to it", () => {
		const state = createState();
		const counter = createVisitCounter();
		const shared = counter.instrument({ inner: state });
		const root = { left: { shared }, right: { shared } };

		expect(discoveredKeys(root)).toEqual(["left", "right"]);
		expect(counter.countVisits()).toBe(1);
	});

	it("descends a cached container once across repeated calls and through a fresh parent", () => {
		const state = createState();
		const counter = createVisitCounter();
		const child = counter.instrument({ inner: state });

		expect(discoveredKeys(child)).toEqual(["inner"]);
		expect(discoveredKeys(child)).toEqual(["inner"]);
		expect(counter.countVisits()).toBe(1);
		expect(discoveredKeys({ child })).toEqual(["child"]);
		expect(counter.countVisits()).toBe(1);
	});

	it("does not surface a state added to a cached container in place, as documented contract", () => {
		const state = createState();
		const container: Record<string, unknown> = { inner: 1 };

		expect(discoveredKeys(container)).toEqual([]);

		container.inner = state;

		expect(discoveredKeys(container)).toEqual([]);
	});

	it("keeps a stale key when a cached container's state is replaced in place, as documented contract", () => {
		const state = createState();
		const container: Record<string, unknown> = { inner: state };

		expect(discoveredKeys(container)).toEqual(["inner"]);

		container.inner = { plain: true };

		expect(discoveredKeys(container)).toEqual(["inner"]);
	});

	it("visits a deeply aliased acyclic graph once per node", () => {
		const state = createState();
		const counter = createVisitCounter();
		let node: object = counter.instrument({ state });

		for (let level = 0; level < 20; level += 1) node = counter.instrument({ left: node, right: node });

		expect(discoverStateKeys(node).size).toBe(2);
		expect(counter.countVisits()).toBe(21);
	});

	it("visits a deeply aliased cyclic graph once per node", () => {
		const state = createState();
		const counter = createVisitCounter();
		const bottom = counter.instrument<Record<string, unknown>>({ state });
		let node: object = bottom;

		for (let level = 0; level < 20; level += 1) node = counter.instrument({ left: node, right: node });

		bottom.back = node;

		expect(discoverStateKeys(node).size).toBe(2);
		expect(counter.countVisits()).toBe(21);
	});
});

describe("substituteStates", () => {
	it("gives one rebuilt object at every position an aliased container occupies", () => {
		const state = createState();
		const shared = { inner: state };
		const root = { left: { shared }, right: { shared } };
		const result = substituteStates(root, wrapSource);

		expect(result.props.left.shared).toBe(result.props.right.shared);
		expect(result.props.left.shared).not.toBe(shared);
	});

	it("returns a state-free subtree by reference and rebuilds only the route to a state", () => {
		const state = createState();
		const inert = { deep: { list: [1, 2, 3] } };
		const holder = { state };
		const root = { inert, holder };
		const result = substituteStates(root, wrapSource);

		expect(result.props.inert).toBe(inert);
		expect(result.props.holder).not.toBe(holder);
		expect(result.props).not.toBe(root);
	});

	it("returns the root itself when props hold no state anywhere", () => {
		const root = { first: 1, nested: { second: [2, 3] } };
		const result: SubstitutionResult<typeof root> = substituteStates(root, wrapSource);

		expect(result.props).toBe(root);
		expect(result.sources).toEqual([]);
	});

	it("preserves a null prototype and a clean class prototype", () => {
		const state = createState();
		const nullPrototype = Object.assign(Object.create(null) as Record<string, unknown>, { inner: state });
		const cleanClass = new CleanHolder(state);
		const result = substituteStates({ nullPrototype, cleanClass }, wrapSource);

		expect(Object.getPrototypeOf(result.props.nullPrototype)).toBe(null);
		expect(result.props.cleanClass).toBeInstanceOf(CleanHolder);
		expect(result.props.cleanClass).not.toBe(cleanClass);
	});

	it("preserves accessors, non-enumerable and symbol-keyed properties without invoking a getter", () => {
		const state = createState();
		const symbolKey = Symbol("tag");
		const source: Record<PropertyKey, unknown> = { inner: state };
		let getterCalls = 0;

		source[symbolKey] = "tagged";

		Object.defineProperty(source, "hidden", { value: 7, enumerable: false, configurable: true });
		Object.defineProperty(source, "derived", {
			get: () => {
				getterCalls += 1;

				return 1;
			},
			enumerable: true,
			configurable: true,
		});

		const result = substituteStates({ source }, wrapSource);
		const rebuilt = result.props.source;

		expect(typeof Object.getOwnPropertyDescriptor(rebuilt, "derived")?.get).toBe("function");
		expect(getterCalls).toBe(0);
		expect(Object.getOwnPropertyDescriptor(rebuilt, "hidden")).toEqual({
			value: 7,
			writable: false,
			enumerable: false,
			configurable: true,
		});
		expect(rebuilt[symbolKey]).toBe("tagged");
		expect(rebuilt.inner).toEqual({ wrapper: state });
	});

	it("leaves a frozen nested container by reference", () => {
		const state = createState();
		const frozen = Object.freeze({ inner: state });
		const result = substituteStates({ frozen }, wrapSource);

		expect(result.props.frozen).toBe(frozen);
		expect(result.sources).toEqual([]);
	});

	it("finds a state on a frozen entry root", () => {
		const state = createState();
		const result = substituteStates(Object.freeze({ inner: state }), wrapSource);

		expect(result.sources[0]).toBe(state);
		expect(result.props.inner).toEqual({ wrapper: state });
	});

	it("finds a state under a __react-prefixed key", () => {
		const state = createState();

		expect(discoveredKeys({ __reactData: state })).toEqual(["__reactData"]);
	});

	it("leaves a non-writable nested object edge unsearched", () => {
		const state = createState();
		const holder: Record<string, unknown> = {};

		Object.defineProperty(holder, "inner", {
			value: { nested: state },
			enumerable: true,
			writable: false,
			configurable: true,
		});

		expect(discoveredKeys({ holder })).toEqual([]);
	});

	it("finds a state on a non-writable entry-root edge", () => {
		const state = createState();
		const root: Record<string, unknown> = {};

		Object.defineProperty(root, "inner", {
			value: state,
			enumerable: true,
			writable: false,
			configurable: true,
		});

		expect(substituteStates(root, wrapSource).sources[0]).toBe(state);
	});

	it("keeps the holes of a sparse array", () => {
		const state = createState();
		const sparse: Array<unknown> = [];

		sparse[0] = state;
		sparse[3] = 1;

		const result = substituteStates({ sparse }, wrapSource);
		const rebuilt = result.props.sparse;

		expect(rebuilt.length).toBe(4);
		expect(1 in rebuilt).toBe(false);
		expect(rebuilt[3]).toBe(1);
		expect(rebuilt[0]).toEqual({ wrapper: state });
	});

	it("rebuilds a cyclic container and points its back-reference at the clone", () => {
		const state = createState();
		const node: Record<string, unknown> = { inner: state };

		node.self = node;

		const result = substituteStates({ node }, wrapSource);
		const rebuilt = result.props.node;

		expect(rebuilt).not.toBe(node);
		expect(rebuilt.self).toBe(rebuilt);
		expect(rebuilt.inner).toEqual({ wrapper: state });
	});

	it("reports deduplicated sources in first-visit order", () => {
		const first = createState();
		const second = createState();
		const root = { one: first, nested: { two: second }, again: first };
		const result = substituteStates(root, wrapSource);

		expect(result.sources.length).toBe(2);
		expect(result.sources[0]).toBe(first);
		expect(result.sources[1]).toBe(second);
	});

	it("leaves a stale key untouched instead of throwing", () => {
		const state = createState();
		const container: Record<string, unknown> = { inner: state };
		const replacement = { plain: true };

		expect(discoveredKeys(container)).toEqual(["inner"]);

		container.inner = replacement;

		const result = substituteStates({ container }, wrapSource);

		expect(result.props.container.inner).toBe(replacement);
	});

	it("leaves a stale key untouched when its replacement is outside the searched domain", () => {
		const state = createState();
		const container: Record<string, unknown> = { inner: state };
		const replacement = new Map<string, number>([["key", 1]]);

		expect(discoveredKeys(container)).toEqual(["inner"]);

		container.inner = replacement;

		const result = substituteStates({ container }, wrapSource);

		expect(result.props.container.inner).toBe(replacement);
	});
});
