import {
	isStateRoot,
	liveRootsOf,
	markStateRoot,
	parentsOf,
	reachesNode,
	registerInEdge,
	unregisterInEdge,
} from "./inEdges";

const parentKeysOf = (child: object): Map<object, Set<string | number>> => {
	const parents = parentsOf(child);

	if (parents === undefined) return new Map();

	return new Map([...parents].map(([parent, keys]) => [parent, new Set(keys)]));
};

describe("inEdges: register and unregister", () => {
	it("registers and unregisters a single edge symmetrically", () => {
		const parent = {};
		const child = {};

		registerInEdge(child, parent, "a");

		expect(parentKeysOf(child).get(parent)).toEqual(new Set(["a"]));

		unregisterInEdge(child, parent, "a");

		expect(parentsOf(child)).toBeUndefined();
	});

	it("accumulates multi-parent and multi-key sets", () => {
		const parentA = {};
		const parentB = {};
		const child = {};

		registerInEdge(child, parentA, "x");
		registerInEdge(child, parentA, "y");
		registerInEdge(child, parentB, 0);

		const parents = parentKeysOf(child);

		expect(parents.get(parentA)).toEqual(new Set(["x", "y"]));
		expect(parents.get(parentB)).toEqual(new Set([0]));

		unregisterInEdge(child, parentA, "x");

		expect(parentKeysOf(child).get(parentA)).toEqual(new Set(["y"]));

		unregisterInEdge(child, parentA, "y");

		expect(parentKeysOf(child).has(parentA)).toBe(false);
		expect(parentKeysOf(child).get(parentB)).toEqual(new Set([0]));
	});

	it("ignores unregister of an unknown edge", () => {
		const parent = {};
		const child = {};

		unregisterInEdge(child, parent, "missing");

		expect(parentsOf(child)).toBeUndefined();

		registerInEdge(child, parent, "a");
		unregisterInEdge(child, parent, "missing");

		expect(parentKeysOf(child).get(parent)).toEqual(new Set(["a"]));
	});
});

describe("inEdges: climbs", () => {
	it("climbs a diamond to the shared root", () => {
		const root = {};
		const left = {};
		const right = {};
		const bottom = {};

		registerInEdge(left, root, "left");
		registerInEdge(right, root, "right");
		registerInEdge(bottom, left, "down");
		registerInEdge(bottom, right, "down");

		const memo = new Map<object, Map<object, boolean>>();

		expect(reachesNode(bottom, root, memo)).toBe(true);
		expect(reachesNode(left, root, memo)).toBe(true);
		expect(reachesNode(root, bottom, memo)).toBe(false);
		expect(reachesNode(bottom, bottom, memo)).toBe(true);
	});

	it("climbs a cycle without looping forever", () => {
		const first = {};
		const second = {};
		const third = {};
		const outsider = {};

		registerInEdge(first, second, "toSecond");
		registerInEdge(second, third, "toThird");
		registerInEdge(third, first, "toFirst");

		const memo = new Map<object, Map<object, boolean>>();

		expect(reachesNode(first, second, memo)).toBe(true);
		expect(reachesNode(first, third, memo)).toBe(true);
		expect(reachesNode(first, outsider, memo)).toBe(false);
	});

	it("reaches the goal when a cycle partner is registered before the root edge", () => {
		const goal = {};
		const nodeA = {};
		const nodeB = {};

		registerInEdge(nodeA, nodeB, "b");
		registerInEdge(nodeB, nodeA, "a");
		registerInEdge(nodeA, goal, "g");

		const memo = new Map<object, Map<object, boolean>>();

		expect(reachesNode(nodeA, goal, memo)).toBe(true);
		expect(reachesNode(nodeB, goal, memo)).toBe(true);
		expect(memo.get(goal)?.get(nodeA)).toBe(true);
		expect(memo.get(goal)?.get(nodeB)).toBe(true);
	});

	it("memoizes per goal so a node cache is not shared across goals", () => {
		const rootA = {};
		const rootB = {};
		const child = {};

		registerInEdge(child, rootA, "a");

		const memo = new Map<object, Map<object, boolean>>();

		expect(reachesNode(child, rootA, memo)).toBe(true);
		expect(reachesNode(child, rootB, memo)).toBe(false);
		expect(memo.get(rootA)?.get(child)).toBe(true);
		expect(memo.get(rootB)?.get(child)).toBe(false);
	});
});

describe("inEdges: state roots", () => {
	it("marks and reports state roots", () => {
		const target = {};

		expect(isStateRoot(target)).toBe(false);

		markStateRoot(target);

		expect(isStateRoot(target)).toBe(true);
	});

	it("collects every state root encountered on the climb, including intermediate ones", () => {
		const outerRoot = {};
		const innerRoot = {};
		const leaf = {};

		markStateRoot(outerRoot);
		markStateRoot(innerRoot);

		registerInEdge(innerRoot, outerRoot, "inner");
		registerInEdge(leaf, innerRoot, "leaf");

		expect(liveRootsOf(leaf)).toEqual(new Set([innerRoot, outerRoot]));
		expect(liveRootsOf(innerRoot)).toEqual(new Set([innerRoot, outerRoot]));
		expect(liveRootsOf(outerRoot)).toEqual(new Set([outerRoot]));
	});

	it("returns empty when no state root is marked on the climb", () => {
		const parent = {};
		const child = {};

		registerInEdge(child, parent, "k");

		expect(liveRootsOf(child)).toEqual(new Set());
	});
});

describe("inEdges: WeakRef parent prune", () => {
	it("prunes a collected parent on read", () => {
		const collectGarbage = (globalThis as { gc?: () => void }).gc;

		if (typeof collectGarbage !== "function") {
			expect(typeof WeakRef).toBe("function");
			return;
		}

		const child = {};
		let parent: object | undefined = {};

		registerInEdge(child, parent, "k");
		expect(parentsOf(child)?.has(parent)).toBe(true);

		parent = undefined;
		collectGarbage();

		expect(parentsOf(child)).toBeUndefined();
	});
});
