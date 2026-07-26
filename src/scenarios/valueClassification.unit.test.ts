import { createElement } from "react";

import { createMutableState } from "../createMutableState";
import { ignore } from "../ignore";
import { TrackedDate } from "../tracked/trackedDate";
import { TrackedMap } from "../tracked/trackedMap";
import { TrackedSet } from "../tracked/trackedSet";
import { unsafeTrack } from "../unsafeTrack";
import { classifyValue, isTrackable, type ValueKind } from "../valtio/classify";

type RemedyTag = "trackedMap" | "trackedSet" | "trackedDate" | "unsafeTrack" | "ignore";

interface Witness {
	readonly name: string;
	readonly create: () => object;
	readonly kind: ValueKind;
	readonly trackable: boolean;
	readonly remedies?: ReadonlyArray<RemedyTag>;
}

class CleanPoint {
	x = 1;
	y = 2;

	sum(): number {
		return this.x + this.y;
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
	public y = 0;

	reveal(): number {
		return this.#secret;
	}
}

class ArraySubclass extends Array<number> {}
class MapSubclass extends Map<string, number> {}

const remedyTags = ["trackedMap", "trackedSet", "trackedDate", "unsafeTrack", "ignore"] as const;

const offeredRemedies = (value: object): ReadonlyArray<RemedyTag> | undefined => {
	try {
		createMutableState({ value });

		return undefined;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const optionsIndex = message.indexOf("Options:");
		const options = optionsIndex === -1 ? "" : message.slice(optionsIndex);

		return remedyTags.filter((tag) => {
			if (tag === "trackedMap") return options.includes("TrackedMap");
			if (tag === "trackedSet") return options.includes("TrackedSet");
			if (tag === "trackedDate") return options.includes("TrackedDate");
			if (tag === "unsafeTrack") return options.includes("unsafeTrack");

			return options.includes("ignore(");
		});
	}
};

const witnesses: ReadonlyArray<Witness> = [
	{ name: "plainObject", create: () => ({ a: 1 }), kind: "plain", trackable: true },
	{
		name: "nullPrototypeObject",
		create: () => Object.assign(Object.create(null) as object, { a: 1 }),
		kind: "plain",
		trackable: true,
	},
	{ name: "plainArray", create: () => [1, 2, 3], kind: "plainArray", trackable: true },
	{
		name: "arraySubclass",
		create: () => new ArraySubclass(),
		kind: "arraySubclass",
		trackable: false,
		remedies: ["unsafeTrack", "ignore"],
	},
	{ name: "cleanClass", create: () => new CleanPoint(), kind: "cleanClass", trackable: true },
	{
		name: "cleanArrowClass",
		create: () => new ArrowPoint(),
		kind: "cleanClass",
		trackable: false,
		remedies: ["unsafeTrack", "ignore"],
	},
	{
		name: "privateClass",
		create: () => new PrivateBox(),
		kind: "privateClass",
		trackable: false,
		remedies: ["unsafeTrack", "ignore"],
	},
	{
		name: "map",
		create: () => new Map([["a", 1]]),
		kind: "nativeClass",
		trackable: false,
		remedies: ["trackedMap", "unsafeTrack", "ignore"],
	},
	{
		name: "set",
		create: () => new Set([1, 2]),
		kind: "nativeClass",
		trackable: false,
		remedies: ["trackedSet", "unsafeTrack", "ignore"],
	},
	{
		name: "date",
		create: () => new Date(0),
		kind: "nativeClass",
		trackable: false,
		remedies: ["trackedDate", "unsafeTrack", "ignore"],
	},
	{
		name: "mapSubclass",
		create: () => new MapSubclass(),
		kind: "nativeClass",
		trackable: false,
		remedies: ["trackedMap", "unsafeTrack", "ignore"],
	},
	{
		name: "regExp",
		create: () => /catalog/g,
		kind: "nativeClass",
		trackable: false,
		remedies: ["unsafeTrack", "ignore"],
	},
	{
		name: "error",
		create: () => new Error("catalog"),
		kind: "nativeClass",
		trackable: false,
		remedies: ["unsafeTrack", "ignore"],
	},
	{
		name: "promise",
		create: () => Promise.resolve(1),
		kind: "nativeClass",
		trackable: false,
		remedies: ["unsafeTrack", "ignore"],
	},
	{
		name: "url",
		create: () => new URL("https://example.com"),
		kind: "privateClass",
		trackable: false,
		remedies: ["unsafeTrack", "ignore"],
	},
	{
		name: "urlSearchParams",
		create: () => new URLSearchParams("a=1"),
		kind: "privateClass",
		trackable: false,
		remedies: ["unsafeTrack", "ignore"],
	},
	{
		name: "typedArray",
		create: () => new Uint8Array([1, 2, 3]),
		kind: "nativeClass",
		trackable: false,
		remedies: ["unsafeTrack", "ignore"],
	},
	{
		name: "arrayBuffer",
		create: () => new ArrayBuffer(8),
		kind: "nativeClass",
		trackable: false,
		remedies: ["unsafeTrack", "ignore"],
	},
	{
		name: "dataView",
		create: () => new DataView(new ArrayBuffer(8)),
		kind: "nativeClass",
		trackable: false,
		remedies: ["unsafeTrack", "ignore"],
	},
	{
		name: "weakMap",
		create: () => new WeakMap(),
		kind: "nativeClass",
		trackable: false,
		remedies: ["unsafeTrack", "ignore"],
	},
	{
		name: "weakSet",
		create: () => new WeakSet(),
		kind: "nativeClass",
		trackable: false,
		remedies: ["unsafeTrack", "ignore"],
	},
	{ name: "frozenPlainObject", create: () => Object.freeze({ a: 1 }), kind: "plain", trackable: false },
	{ name: "frozenCleanClass", create: () => Object.freeze(new CleanPoint()), kind: "cleanClass", trackable: false },
	{
		name: "frozenCleanArrowClass",
		create: () => Object.freeze(new ArrowPoint()),
		kind: "cleanClass",
		trackable: false,
	},
	{ name: "ignoredValue", create: () => ignore({ a: 1 }), kind: "plain", trackable: false },
	{
		name: "unsafeTrackedCleanArrowClass",
		create: () => unsafeTrack(new ArrowPoint()),
		kind: "cleanClass",
		trackable: true,
	},
	{
		name: "unsafeTrackedPrivateClass",
		create: () => unsafeTrack(new PrivateBox()),
		kind: "privateClass",
		trackable: true,
	},
	{
		name: "frozenUnsafeTrackedValue",
		create: () => unsafeTrack(Object.freeze({ a: 1 })),
		kind: "plain",
		trackable: true,
	},
	{
		name: "trackedMap",
		create: () => new TrackedMap<string, number>([["a", 1]]),
		kind: "cleanClass",
		trackable: true,
	},
	{ name: "trackedSet", create: () => new TrackedSet<number>([1, 2]), kind: "cleanClass", trackable: true },
	{ name: "trackedDate", create: () => new TrackedDate(0), kind: "cleanClass", trackable: true },
	{
		name: "reactElement",
		create: () => createElement("div", { id: "probe" }, "leaf") as object,
		kind: "plain",
		trackable: false,
	},
];

describe("valueClassification", () => {
	it.each(witnesses.map((witness) => [witness.name, witness] as const))("%s", (_name, witness) => {
		const value = witness.create();

		expect(classifyValue(value)).toBe(witness.kind);
		expect(isTrackable(value)).toBe(witness.trackable);
		expect(offeredRemedies(value)).toEqual(witness.remedies);
	});
});
