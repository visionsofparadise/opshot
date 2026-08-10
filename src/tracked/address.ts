import { internIdentity } from "../identity";

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
