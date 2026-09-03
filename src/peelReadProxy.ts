import { getRegisteredReadProxyTarget } from "./identity";
import { isObjectLike } from "./utils/predicates";

export function peelReadProxy(value: unknown): unknown {
	if (!isObjectLike(value)) return value;

	let current: unknown = value;

	while (isObjectLike(current)) {
		const registeredTarget = getRegisteredReadProxyTarget(current);

		if (registeredTarget === undefined) break;

		current = registeredTarget;
	}

	return current;
}
