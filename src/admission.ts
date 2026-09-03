import { nonWritablePropertyError, rejectionError } from "./boundaryErrors";
import { admissionDecision, classifyValue } from "./classify";
import { isIgnored } from "./ignore";
import { recordOf } from "./node";
import { isUnsafeMarked } from "./unsafeTrack";
import { walkDataEntries } from "./utils/dataEntries";
import type { Handle } from "./handle";

export function assertAdmissible(handle: Handle, value: object, route: Array<string>, exempt: boolean): void {
	const visited = new Set<object>();

	const walk = (node: object, nodeRoute: Array<string>, nodeExempt: boolean): void => {
		if (nodeExempt) return;

		if (visited.has(node)) return;

		visited.add(node);

		const decision = admissionDecision(node);

		if (decision.lane === "dangerous") throw rejectionError(node, decision.kind, nodeRoute);

		for (const entry of walkDataEntries(node)) {
			if (typeof entry.value === "function") {
				if (classifyValue(node) === "cleanClass")
					throw rejectionError(node, "cleanClass", [...nodeRoute, entry.key]);

				continue;
			}

			if (typeof entry.value !== "object" || entry.value === null) continue;

			if (isIgnored(entry.value) || Object.isFrozen(entry.value)) continue;

			if (!entry.writable) throw nonWritablePropertyError(node, [...nodeRoute, entry.key]);

			const childRecord = recordOf(entry.value);
			const childMembership = childRecord?.memberships.get(handle);

			if (childMembership !== undefined && !childMembership.exempt) continue;

			walk(entry.value, [...nodeRoute, entry.key], isUnsafeMarked(entry.value));
		}
	};

	walk(value, route, exempt);
}
