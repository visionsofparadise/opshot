export type OperationPath = ReadonlyArray<unknown>;

type PathSelectorKind = "keyOf" | "valueOf";

interface PathSelector {
	readonly kind: PathSelectorKind;
	readonly value: unknown;
}

const pathSelectorBrand = Symbol.for("opshot.pathSelector");

export const createOperationPath = (segments: ReadonlyArray<unknown>): OperationPath => Object.freeze([...segments]);

export const appendOperationPath = (path: OperationPath, segment: unknown): OperationPath => Object.freeze([...path, segment]);

const createPathSelector = (kind: PathSelectorKind, value: unknown): object => {
	const selector = {};

	Object.defineProperties(selector, {
		[pathSelectorBrand]: { value: true },
		kind: { value: kind, enumerable: true },
		value: { value, enumerable: true },
	});

	return Object.freeze(selector);
};

export const createKeyOfPathSegment = (value: unknown): object => createPathSelector("keyOf", value);

export const createValueOfPathSegment = (value: unknown): object => createPathSelector("valueOf", value);

export const getPathSelector = (segment: unknown): PathSelector | undefined => {
	if (typeof segment !== "object" || segment === null || Reflect.get(segment, pathSelectorBrand) !== true) return undefined;

	const kind: unknown = Reflect.get(segment, "kind");

	if (kind !== "keyOf" && kind !== "valueOf") return undefined;

	return { kind, value: Reflect.get(segment, "value") };
};

const escapeSegment = (segment: string): string => segment.replaceAll("~", "~0").replaceAll("/", "~1");

const formatSegment = (segment: unknown): string => {
	const selector = getPathSelector(segment);

	if (selector) return `<${selector.kind}>`;
	if (typeof segment === "symbol") return "<symbol>";
	if ((typeof segment === "object" && segment !== null) || typeof segment === "function") return "<identity>";
	if (typeof segment === "string") return escapeSegment(segment);
	if (typeof segment === "number" || typeof segment === "bigint" || typeof segment === "boolean") return String(segment);
	if (segment === null) return "null";

	return "undefined";
};

export const formatOperationPath = (path: OperationPath): string => (path.length === 0 ? "" : `/${path.map(formatSegment).join("/")}`);
