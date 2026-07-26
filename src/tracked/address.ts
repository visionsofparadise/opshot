import { resolveIdentity } from "../identity";

const internTable = new WeakMap<WeakKey, number>();
let nextInternId = 0;

const internIdentity = (key: object | symbol): number => {
	const resolved = resolveIdentity(key);

	if (
		resolved === null ||
		(typeof resolved !== "object" && typeof resolved !== "function" && typeof resolved !== "symbol")
	) {
		throw new Error("opshot: addressOf interned a non-identity value");
	}

	const existing = internTable.get(resolved);

	if (existing !== undefined) return existing;

	const id = nextInternId;

	nextInternId += 1;
	internTable.set(resolved, id);

	return id;
};

export const addressOf = (key: unknown): string => {
	if (key === null) return "z";

	if (key === undefined) return "u";

	switch (typeof key) {
		case "string":
			return `s${key}`;
		case "number":
			return `n${String(key)}`;
		case "bigint":
			return `i${String(key)}`;
		case "boolean":
			return key ? "b1" : "b0";
		case "symbol": {
			const registered = Symbol.keyFor(key);

			if (registered !== undefined) return `r${registered}`;

			return `o${internIdentity(key)}`;
		}

		case "object":
		case "function":
			return `o${internIdentity(key)}`;
		default:
			throw new Error(`opshot: addressOf received unsupported key type ${typeof key}`);
	}
};
