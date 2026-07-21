import { createElement } from "react";

import { createState } from "../createState";
import { ignore } from "../ignore";
import { TrackedDate } from "../tracked/trackedDate";
import { TrackedMap } from "../tracked/trackedMap";
import { TrackedSet } from "../tracked/trackedSet";

export type Lane = "tracked" | "cyclic" | "throwsAtAttach" | "registeredCopy" | "autoIgnored" | "ignored" | "leaf";
export type OperationLane = "containerTranslation" | "collectionKeyInterior" | "sparseArray" | "equalContentReplacement" | "sameTargetInterior" | "none";
export type ContentsLane = "ignored";

export interface CatalogEntry {
	readonly name: string;
	readonly lane: Lane;
	readonly operationLane?: OperationLane;
	readonly contentsLane?: ContentsLane;
	readonly create: () => unknown;
}

class CleanPoint {
	x = 1;
	y = 2;

	sum(): number {
		return this.x + this.y;
	}
}

class PrivateBox {
	#secret = 1;

	reveal(): number {
		return this.#secret;
	}
}

class ArraySubclass extends Array<number> {}
class MapSubclass extends Map<string, number> {}

const makeSelfCycle = (): unknown => {
	const node: Record<string, unknown> = { n: 1 };

	node.self = node;

	return node;
};

const makeDeepCycle = (): unknown => {
	const root: Record<string, unknown> = { child: { n: 1 } };

	(root.child as Record<string, unknown>).back = root;

	return root;
};

const makeReactElement = (): unknown => createElement("div", { id: "probe" }, "leaf");

const makeRegisteredCopy = (): unknown => createState({ item: { value: 1 } }).item;

export const catalog: ReadonlyArray<CatalogEntry> = [
	{ name: "number", lane: "tracked", create: () => 42 },
	{ name: "string", lane: "tracked", create: () => "hello" },
	{ name: "boolean", lane: "tracked", create: () => true },
	{ name: "null", lane: "tracked", create: () => null },
	{ name: "undefinedValue", lane: "tracked", create: () => undefined },
	{ name: "NaN", lane: "tracked", create: () => Number.NaN },
	{ name: "negativeZero", lane: "tracked", create: () => -0 },
	{ name: "bigintValue", lane: "tracked", create: () => 10n },
	{ name: "symbolValue", lane: "tracked", create: () => Symbol("catalog") },
	{ name: "plainObject", lane: "tracked", create: () => ({ a: 1, b: 2 }) },
	{ name: "equalContentDifferentTarget", lane: "tracked", operationLane: "equalContentReplacement", create: () => ({ value: 1 }) },
	{ name: "sameTargetInteriorMutation", lane: "tracked", operationLane: "sameTargetInterior", create: () => ({ value: 1 }) },
	{ name: "nestedPlainObject", lane: "tracked", create: () => ({ a: { b: { c: 1 } } }) },
	{ name: "plainArray", lane: "tracked", create: () => [1, 2, 3] },
	{ name: "nestedArray", lane: "tracked", create: () => [[1], [2, 3]] },
	{ name: "nullPrototypeObject", lane: "tracked", create: () => Object.assign(Object.create(null) as object, { a: 1 }) },
	{ name: "objectWithGetter", lane: "tracked", create: () => ({ base: 2, get derived(): number { return 1; } }) },
	{ name: "symbolKeyedProp", lane: "tracked", create: () => ({ a: 1, [Symbol("ride")]: 2 }) },
	{
		name: "nonEnumerableProp",
		lane: "tracked",
		create: () => {
			const object: Record<string, unknown> = { a: 1 };

			Object.defineProperty(object, "hidden", { value: 2, enumerable: false });

			return object;
		},
	},
	{
		name: "sparseArray",
		lane: "tracked",
		operationLane: "sparseArray",
		create: () => {
			const array = [1];

			array[3] = 4;

			return array;
		},
	},
	{ name: "storedUndefinedArray", lane: "tracked", create: () => [1, undefined, 3] },
	{
		name: "sharedDag",
		lane: "tracked",
		create: () => {
			const shared = { n: 1 };

			return { left: shared, right: shared };
		},
	},
	{ name: "selfCycle", lane: "cyclic", create: makeSelfCycle },
	{ name: "deepCycle", lane: "cyclic", create: makeDeepCycle },
	{ name: "frozenPlainObject", lane: "autoIgnored", create: () => Object.freeze({ a: 1 }) },
	{ name: "rawMap", lane: "throwsAtAttach", create: () => new Map([["a", 1]]) },
	{ name: "rawSet", lane: "throwsAtAttach", create: () => new Set([1, 2]) },
	{ name: "rawDate", lane: "throwsAtAttach", create: () => new Date(0) },
	{ name: "cleanClassInstance", lane: "throwsAtAttach", create: () => new CleanPoint() },
	{ name: "privateFieldClassInstance", lane: "throwsAtAttach", create: () => new PrivateBox() },
	{ name: "arraySubclass", lane: "throwsAtAttach", create: () => new ArraySubclass() },
	{ name: "mapSubclass", lane: "throwsAtAttach", create: () => new MapSubclass() },
	{ name: "regExp", lane: "throwsAtAttach", create: () => /catalog/g },
	{ name: "errorValue", lane: "throwsAtAttach", create: () => new Error("catalog") },
	{ name: "promise", lane: "throwsAtAttach", create: () => Promise.resolve(1) },
	{ name: "url", lane: "throwsAtAttach", create: () => new URL("https://example.com") },
	{ name: "urlSearchParams", lane: "throwsAtAttach", create: () => new URLSearchParams("a=1") },
	{ name: "typedArray", lane: "throwsAtAttach", create: () => new Uint8Array([1, 2, 3]) },
	{ name: "arrayBuffer", lane: "throwsAtAttach", create: () => new ArrayBuffer(8) },
	{ name: "dataView", lane: "throwsAtAttach", create: () => new DataView(new ArrayBuffer(8)) },
	{ name: "weakMap", lane: "throwsAtAttach", create: () => new WeakMap() },
	{ name: "weakSet", lane: "throwsAtAttach", create: () => new WeakSet() },
	{ name: "ignoredMap", lane: "ignored", create: () => ignore(new Map([["a", 1]])) },
	{ name: "ignoredClassInstance", lane: "ignored", create: () => ignore(new CleanPoint()) },
	{ name: "ignoredCycle", lane: "ignored", create: () => ignore(makeSelfCycle() as object) },
	{ name: "registeredCopyDonation", lane: "registeredCopy", operationLane: "none", create: makeRegisteredCopy },
	{ name: "trackedMap", lane: "tracked", operationLane: "containerTranslation", create: () => new TrackedMap<string, number>([["a", 1]]) },
	{
		name: "trackedMapObjectKeys",
		lane: "tracked",
		operationLane: "collectionKeyInterior",
		create: () => new TrackedMap<{ id: number }, string>([[{ id: 1 }, "one"]]),
	},
	{ name: "trackedSet", lane: "tracked", operationLane: "containerTranslation", create: () => new TrackedSet<number>([1, 2]) },
	{
		name: "trackedSetIgnoredMember",
		lane: "tracked",
		operationLane: "containerTranslation",
		contentsLane: "ignored",
		create: () => new TrackedSet([ignore(new CleanPoint())]),
	},
	{ name: "trackedDate", lane: "tracked", operationLane: "containerTranslation", create: () => new TrackedDate(0) },
	{ name: "namedFunction", lane: "leaf", create: () => function named(): number { return 1; } },
	{ name: "arrowFunction", lane: "leaf", create: () => () => 1 },
	{ name: "reactElement", lane: "leaf", operationLane: "none", create: makeReactElement },
];
