export type Ancestors = Map<object, Set<object>>;

export class MissingAncestorPairError extends Error {
	constructor() {
		super("opshot: exitAncestorPair without matching enterAncestorPair");
		this.name = "MissingAncestorPairError";
	}
}

export const hasAncestorPair = (ancestors: Ancestors, before: object, after: object): boolean =>
	ancestors.get(before)?.has(after) ?? false;

export const enterAncestorPair = (ancestors: Ancestors, before: object, after: object): void => {
	const afterSet = ancestors.get(before) ?? new Set<object>();

	afterSet.add(after);
	ancestors.set(before, afterSet);
};

export const exitAncestorPair = (ancestors: Ancestors, before: object, after: object): void => {
	const afterSet = ancestors.get(before);

	if (afterSet === undefined) throw new MissingAncestorPairError();

	afterSet.delete(after);

	if (afterSet.size === 0) ancestors.delete(before);
};

export const walkContainer = (ancestors: Ancestors, before: object, after: object, walk: () => void): void => {
	if (hasAncestorPair(ancestors, before, after)) return;

	enterAncestorPair(ancestors, before, after);

	try {
		walk();
	} finally {
		exitAncestorPair(ancestors, before, after);
	}
};
