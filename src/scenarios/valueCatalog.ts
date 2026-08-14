import { createElement } from "react";
import { ignore } from "../ignore";
import { TrackedDate } from "../tracked/trackedDate";
import { TrackedMap } from "../tracked/trackedMap";
import { TrackedSet } from "../tracked/trackedSet";
import { unsafeTrack } from "../unsafeTrack";

export const behaviorNames = [
	"attachesAtCreate",
	"attachesByBareWrite",
	"readBackIsRawReference",
	"readBackResolvesToSameIdentity",
	"emitsOnInteriorMutation",
	"roundTripsFaithfully",
	"methodsWork",
	"methodInteriorWritesEmit",
] as const;

export const scopeBehaviorNames = ["rendersOnChange", "walkThrows"] as const;

export type BehaviorName = (typeof behaviorNames)[number];
export type ScopeBehaviorName = (typeof scopeBehaviorNames)[number];

export interface CatalogEntry {
	readonly name: string;
	readonly create: () => unknown;
	readonly expect: Record<BehaviorName, boolean>;
	readonly scopeExpect?: Record<ScopeBehaviorName, boolean>;
}

class CleanPoint {
	x = 1;
	y = 2;

	sum(): number {
		return this.x + this.y;
	}
}

class CleanMutatingPoint {
	x = 1;

	bump(): void {
		this.x += 1;
	}
}

class ArrowPoint {
	x = 1;
	y = 2;
	bump = (): void => {
		this.x += 1;
	};
}

class PrivateBox {
	#secret = 1;

	reveal(): number {
		return this.#secret;
	}
}

class PrivatePublicBox {
	#secret = 1;
	public x = 0;

	reveal(): number {
		return this.#secret;
	}
}

class PrivatePublicCycle {
	#secret = 1;
	public x = 0;
	public self: PrivatePublicCycle;

	constructor() {
		this.self = this;
	}

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

const primitive = {
	attachesAtCreate: true,
	attachesByBareWrite: true,
	readBackIsRawReference: true,
	readBackResolvesToSameIdentity: false,
	emitsOnInteriorMutation: true,
	roundTripsFaithfully: true,
	methodsWork: true,
	methodInteriorWritesEmit: false,
} satisfies Record<BehaviorName, boolean>;

const trackedData = {
	attachesAtCreate: true,
	attachesByBareWrite: true,
	readBackIsRawReference: false,
	readBackResolvesToSameIdentity: true,
	emitsOnInteriorMutation: true,
	roundTripsFaithfully: true,
	methodsWork: true,
	methodInteriorWritesEmit: false,
} satisfies Record<BehaviorName, boolean>;

const trackedWithMutatingMethods = {
	...trackedData,
	methodInteriorWritesEmit: true,
} satisfies Record<BehaviorName, boolean>;

const cyclic = {
	attachesAtCreate: true,
	attachesByBareWrite: true,
	readBackIsRawReference: false,
	readBackResolvesToSameIdentity: true,
	emitsOnInteriorMutation: true,
	roundTripsFaithfully: true,
	methodsWork: true,
	methodInteriorWritesEmit: false,
} satisfies Record<BehaviorName, boolean>;

const autoIgnoredFrozen = {
	attachesAtCreate: true,
	attachesByBareWrite: true,
	readBackIsRawReference: true,
	readBackResolvesToSameIdentity: true,
	emitsOnInteriorMutation: false,
	roundTripsFaithfully: false,
	methodsWork: true,
	methodInteriorWritesEmit: false,
} satisfies Record<BehaviorName, boolean>;

const dangerous = {
	attachesAtCreate: false,
	attachesByBareWrite: false,
	readBackIsRawReference: false,
	readBackResolvesToSameIdentity: false,
	emitsOnInteriorMutation: false,
	roundTripsFaithfully: false,
	methodsWork: false,
	methodInteriorWritesEmit: false,
} satisfies Record<BehaviorName, boolean>;

const dangerousEmptyMethods = {
	...dangerous,
	methodsWork: true,
} satisfies Record<BehaviorName, boolean>;

const ignored = {
	attachesAtCreate: true,
	attachesByBareWrite: true,
	readBackIsRawReference: true,
	readBackResolvesToSameIdentity: true,
	emitsOnInteriorMutation: false,
	roundTripsFaithfully: true,
	methodsWork: true,
	methodInteriorWritesEmit: false,
} satisfies Record<BehaviorName, boolean>;

const leafFunction = {
	attachesAtCreate: true,
	attachesByBareWrite: true,
	readBackIsRawReference: true,
	readBackResolvesToSameIdentity: true,
	emitsOnInteriorMutation: false,
	roundTripsFaithfully: true,
	methodsWork: true,
	methodInteriorWritesEmit: false,
} satisfies Record<BehaviorName, boolean>;

const unsafePrivate = {
	attachesAtCreate: true,
	attachesByBareWrite: true,
	readBackIsRawReference: false,
	readBackResolvesToSameIdentity: true,
	emitsOnInteriorMutation: true,
	roundTripsFaithfully: true,
	methodsWork: false,
	methodInteriorWritesEmit: false,
} satisfies Record<BehaviorName, boolean>;

const unsafePrivateCycle = {
	attachesAtCreate: true,
	attachesByBareWrite: true,
	readBackIsRawReference: false,
	readBackResolvesToSameIdentity: true,
	emitsOnInteriorMutation: true,
	roundTripsFaithfully: true,
	methodsWork: false,
	methodInteriorWritesEmit: false,
} satisfies Record<BehaviorName, boolean>;

const scopeRenders = { rendersOnChange: true, walkThrows: false } satisfies Record<ScopeBehaviorName, boolean>;
const scopeInert = { rendersOnChange: false, walkThrows: false } satisfies Record<ScopeBehaviorName, boolean>;

export const catalog = [
	{ name: "number", create: () => 42, expect: primitive },
	{ name: "string", create: () => "hello", expect: primitive },
	{ name: "boolean", create: () => true, expect: primitive },
	{ name: "null", create: () => null, expect: primitive },
	{ name: "undefinedValue", create: () => undefined, expect: primitive },
	{ name: "NaN", create: () => Number.NaN, expect: primitive },
	{ name: "negativeZero", create: () => -0, expect: primitive },
	{ name: "bigintValue", create: () => 10n, expect: primitive },
	{ name: "symbolValue", create: () => Symbol("catalog"), expect: primitive },
	{ name: "plainObject", create: () => ({ a: 1, b: 2 }), expect: trackedData, scopeExpect: scopeRenders },
	{
		name: "nestedPlainObject",
		create: () => ({ a: { b: { c: 1 } } }),
		expect: trackedData,
		scopeExpect: scopeRenders,
	},
	{ name: "plainArray", create: () => [1, 2, 3], expect: trackedWithMutatingMethods, scopeExpect: scopeRenders },
	{ name: "nestedArray", create: () => [[1], [2, 3]], expect: trackedWithMutatingMethods, scopeExpect: scopeRenders },
	{
		name: "nullPrototypeObject",
		create: () => Object.assign(Object.create(null) as object, { a: 1 }),
		expect: trackedData,
		scopeExpect: scopeRenders,
	},
	{
		name: "objectWithGetter",
		create: () => ({
			base: 2,
			get derived(): number {
				return 1;
			},
		}),
		expect: trackedData,
		scopeExpect: scopeRenders,
	},
	{
		name: "symbolKeyedProp",
		create: () => ({ a: 1, [Symbol("ride")]: 2 }),
		expect: trackedData,
		scopeExpect: scopeRenders,
	},
	{
		name: "nonEnumerableProp",
		create: () => {
			const object: Record<string, unknown> = { a: 1 };

			Object.defineProperty(object, "hidden", { value: 2, enumerable: false });

			return object;
		},
		expect: trackedData,
		scopeExpect: scopeRenders,
	},
	{
		name: "sparseArray",
		create: () => {
			const array = [1];

			array[3] = 4;

			return array;
		},
		expect: trackedWithMutatingMethods,
		scopeExpect: scopeRenders,
	},
	{
		name: "storedUndefinedArray",
		create: () => [1, undefined, 3],
		expect: trackedWithMutatingMethods,
		scopeExpect: scopeRenders,
	},
	{
		name: "sharedDag",
		create: () => {
			const shared = { n: 1 };

			return { left: shared, right: shared };
		},
		expect: trackedData,
		scopeExpect: scopeRenders,
	},
	{ name: "selfCycle", create: makeSelfCycle, expect: cyclic, scopeExpect: scopeRenders },
	{ name: "deepCycle", create: makeDeepCycle, expect: cyclic, scopeExpect: scopeRenders },
	{ name: "frozenPlainObject", create: () => Object.freeze({ a: 1 }), expect: autoIgnoredFrozen },
	{ name: "frozenCleanClass", create: () => Object.freeze(new CleanPoint()), expect: autoIgnoredFrozen },
	{ name: "frozenMap", create: () => Object.freeze(new Map([["a", 1]])), expect: autoIgnoredFrozen },
	{ name: "frozenSet", create: () => Object.freeze(new Set([1, 2])), expect: autoIgnoredFrozen },
	{ name: "frozenDate", create: () => Object.freeze(new Date(0)), expect: autoIgnoredFrozen },
	{ name: "rawMap", create: () => new Map([["a", 1]]), expect: dangerous, scopeExpect: scopeInert },
	{ name: "rawSet", create: () => new Set([1, 2]), expect: dangerous, scopeExpect: scopeInert },
	{ name: "rawDate", create: () => new Date(0), expect: dangerous, scopeExpect: scopeInert },
	{ name: "cleanClassInstance", create: () => new CleanPoint(), expect: trackedData, scopeExpect: scopeRenders },
	{
		name: "cleanMutatingClassInstance",
		create: () => new CleanMutatingPoint(),
		expect: trackedWithMutatingMethods,
		scopeExpect: scopeRenders,
	},
	{ name: "cleanArrowClassInstance", create: () => new ArrowPoint(), expect: dangerous, scopeExpect: scopeRenders },
	{
		name: "unsafeTrackedCleanArrowClass",
		create: () => unsafeTrack(new ArrowPoint()),
		expect: trackedData,
		scopeExpect: scopeRenders,
	},
	{ name: "privateFieldClassInstance", create: () => new PrivateBox(), expect: dangerous, scopeExpect: scopeInert },
	{
		name: "unsafeTrackedPrivateClass",
		create: () => unsafeTrack(new PrivatePublicBox()),
		expect: unsafePrivate,
		scopeExpect: scopeInert,
	},
	{
		name: "unsafeTrackedPrivateCycle",
		create: () => unsafeTrack(new PrivatePublicCycle()),
		expect: unsafePrivateCycle,
		scopeExpect: scopeInert,
	},
	{ name: "arraySubclass", create: () => new ArraySubclass(), expect: dangerous, scopeExpect: scopeInert },
	{ name: "mapSubclass", create: () => new MapSubclass(), expect: dangerous, scopeExpect: scopeInert },
	{ name: "regExp", create: () => /catalog/g, expect: dangerous, scopeExpect: scopeInert },
	{ name: "errorValue", create: () => new Error("catalog"), expect: dangerous, scopeExpect: scopeInert },
	{ name: "promise", create: () => Promise.resolve(1), expect: dangerousEmptyMethods, scopeExpect: scopeInert },
	{ name: "url", create: () => new URL("https://example.com"), expect: dangerous, scopeExpect: scopeInert },
	{ name: "urlSearchParams", create: () => new URLSearchParams("a=1"), expect: dangerous, scopeExpect: scopeInert },
	{ name: "typedArray", create: () => new Uint8Array([1, 2, 3]), expect: dangerous, scopeExpect: scopeInert },
	{ name: "arrayBuffer", create: () => new ArrayBuffer(8), expect: dangerous, scopeExpect: scopeInert },
	{
		name: "dataView",
		create: () => new DataView(new ArrayBuffer(8)),
		expect: dangerousEmptyMethods,
		scopeExpect: scopeInert,
	},
	{ name: "weakMap", create: () => new WeakMap(), expect: dangerousEmptyMethods, scopeExpect: scopeInert },
	{ name: "weakSet", create: () => new WeakSet(), expect: dangerousEmptyMethods, scopeExpect: scopeInert },
	{ name: "ignoredMap", create: () => ignore(new Map([["a", 1]])), expect: ignored, scopeExpect: scopeInert },
	{ name: "ignoredClassInstance", create: () => ignore(new CleanPoint()), expect: ignored, scopeExpect: scopeInert },
	{
		name: "ignoredCycle",
		create: () => ignore(makeSelfCycle() as object),
		expect: ignored,
		scopeExpect: scopeInert,
	},
	{
		name: "trackedMap",
		create: () => new TrackedMap<string, number>([["a", 1]]),
		expect: trackedWithMutatingMethods,
		scopeExpect: scopeRenders,
	},
	{
		name: "trackedMapObjectKeys",
		create: () => new TrackedMap<{ id: number }, string>([[{ id: 1 }, "one"]]),
		expect: trackedWithMutatingMethods,
		scopeExpect: scopeRenders,
	},
	{
		name: "trackedSet",
		create: () => new TrackedSet<number>([1, 2]),
		expect: trackedWithMutatingMethods,
		scopeExpect: scopeRenders,
	},
	{
		name: "trackedSetIgnoredMember",
		create: () => new TrackedSet([ignore(new CleanPoint())]),
		expect: trackedWithMutatingMethods,
		scopeExpect: scopeRenders,
	},
	{
		name: "trackedDate",
		create: () => new TrackedDate(0),
		expect: trackedWithMutatingMethods,
		scopeExpect: scopeRenders,
	},
	{
		name: "namedFunction",
		create: () =>
			function named(): number {
				return 1;
			},
		expect: leafFunction,
	},
	{ name: "arrowFunction", create: () => () => 1, expect: leafFunction },
	{ name: "reactElement", create: makeReactElement, expect: autoIgnoredFrozen },
] satisfies ReadonlyArray<CatalogEntry>;
