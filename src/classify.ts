export type ValueKind = "plain" | "plainArray" | "arraySubclass" | "cleanClass" | "privateClass" | "nativeClass";

const sourceCache = new WeakMap<Function, string>();
const kindCache = new WeakMap<Function, ValueKind>();

const readSource = (constructor: Function): string => {
	const cached = sourceCache.get(constructor);

	if (cached !== undefined) return cached;

	const source = Function.prototype.toString.call(constructor);

	sourceCache.set(constructor, source);

	return source;
};

const privateNameAccess = /\.\s*#[A-Za-z_$]/;
const privateNameDeclaration = new RegExp(
	String.raw`[{;}](?:\s|\/\*[\s\S]*?\*\/|\/\/[^\n]*\n|static\b|async\b|get\b|set\b|\*)*` +
		String.raw`#[A-Za-z_$][\w$]*` +
		String.raw`(?:[ \t]*(?:\/\*[\s\S]*?\*\/[ \t]*)*[(=;}]|[ \t]*(?:\/\/[^\n]*|\/\*[\s\S]*?\*\/[ \t]*)?(?:\r?\n|$))`,
	"m",
);

const hasPrivateName = (source: string): boolean =>
	privateNameAccess.test(source) || privateNameDeclaration.test(source);

const classifyChain = (initialConstructor: unknown): ValueKind => {
	if (typeof initialConstructor !== "function") return "cleanClass";

	const cached = kindCache.get(initialConstructor);

	if (cached !== undefined) return cached;

	let sawNativeSource = false;
	let current: unknown = initialConstructor;
	let kind: ValueKind = "cleanClass";

	while (typeof current === "function" && current !== Object && current !== Array && current !== Function.prototype) {
		const source = readSource(current);

		if (hasPrivateName(source)) {
			kind = "privateClass";

			break;
		}

		if (source.includes("[native code]")) sawNativeSource = true;

		current = Reflect.getPrototypeOf(current);
	}

	if (kind !== "privateClass") kind = sawNativeSource ? "nativeClass" : "cleanClass";

	kindCache.set(initialConstructor, kind);

	return kind;
};

export function classifyValue(value: object): ValueKind {
	const prototype: unknown = Object.getPrototypeOf(value);

	if (Array.isArray(value))
		return prototype === Array.prototype || prototype === null ? "plainArray" : "arraySubclass";

	if (prototype === Object.prototype || prototype === null) return "plain";

	return classifyChain(value.constructor);
}
