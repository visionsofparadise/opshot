import { createElement } from "react";
import { createMutableState } from "../createMutableState";
import { ignore } from "../ignore";
import { unsafeTrack } from "../unsafeTrack";
import { discoverStateKeys, substituteStates } from "./propWalk";

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

const createState = (): object => createMutableState({ count: 0 });

const wrapSource = (source: object): object => ({ wrapper: source });

const discoveredKeys = (container: object): Array<string> => [...discoverStateKeys(container)].sort();

describe("discoverStateKeys", () => {
	it("finds every state at mixed depths and counts no key that leads to none", () => {
		const first = createState();
		const second = createState();
		const third = createState();
		const root = { first, nested: { second }, list: [0, { third }], stateless: { count: 1 } };

		expect(discoveredKeys(root)).toEqual(["first", "list", "nested"]);
		expect(discoveredKeys(root.nested)).toEqual(["second"]);
		expect(discoveredKeys(root.list)).toEqual(["1"]);
	});

	it("finds a state inside an unsafeTrack'd dangerous-kind container", () => {
		const state = createState();

		expect(discoverStateKeys({ container: unsafeTrack(new PrivateHolder(state)) }).size > 0).toBe(true);
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

	it("finds a state reachable only through a back-edge", () => {
		const state = createState();
		const first: Record<string, unknown> = { state };
		const second: Record<string, unknown> = { first };

		first.second = second;

		expect(discoveredKeys(first)).toEqual(["second", "state"]);
		expect(discoveredKeys(second)).toEqual(["first"]);
	});

	it("finds a state through both aliases of a shared container", () => {
		const state = createState();
		const shared = { inner: state };
		const root = { left: { shared }, right: { shared } };

		expect(discoveredKeys(root)).toEqual(["left", "right"]);
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
});

describe("substituteStates", () => {
	it("finds a state on a frozen entry root", () => {
		const state = createState();
		const result = substituteStates(Object.freeze({ inner: state }), wrapSource);

		expect(result.sources[0]).toBe(state);
		expect(result.props.inner).toEqual({ wrapper: state });
	});
});
