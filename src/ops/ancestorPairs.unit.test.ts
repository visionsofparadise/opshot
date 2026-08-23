import {
	enterAncestorPair,
	exitAncestorPair,
	hasAncestorPair,
	MissingAncestorPairError,
	walkContainer,
	type Ancestors,
} from "./ancestorPairs";

const emptyAncestors = (): Ancestors => new Map();

describe("ancestorPairs", () => {
	it("balances enter and exit of a pair", () => {
		const ancestors = emptyAncestors();
		const before = {};
		const after = {};

		enterAncestorPair(ancestors, before, after);

		expect(hasAncestorPair(ancestors, before, after)).toBe(true);

		exitAncestorPair(ancestors, before, after);

		expect(hasAncestorPair(ancestors, before, after)).toBe(false);
		expect(ancestors.size).toBe(0);
	});

	it("skips a repeated pair on re-entry", () => {
		const ancestors = emptyAncestors();
		const before = {};
		const after = {};
		const walked: Array<string> = [];

		walkContainer(ancestors, before, after, () => {
			walked.push("outer");
			walkContainer(ancestors, before, after, () => {
				walked.push("inner");
			});
		});

		expect(walked).toEqual(["outer"]);
		expect(hasAncestorPair(ancestors, before, after)).toBe(false);
	});

	it("cleans up the pair when walk throws", () => {
		const ancestors = emptyAncestors();
		const before = {};
		const after = {};

		expect(() =>
			walkContainer(ancestors, before, after, () => {
				throw new Error("boom");
			}),
		).toThrow("boom");

		expect(hasAncestorPair(ancestors, before, after)).toBe(false);
		expect(ancestors.size).toBe(0);
	});

	it("throws MissingAncestorPairError on unbalanced exit", () => {
		const ancestors = emptyAncestors();

		expect(() => exitAncestorPair(ancestors, {}, {})).toThrow(MissingAncestorPairError);
	});
});
