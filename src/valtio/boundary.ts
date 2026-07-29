import { getUntracked } from "proxy-compare";
import { unstable_getInternalStates, unstable_replaceInternalFunction } from "valtio/vanilla";
import { getRegisteredTarget } from "../identity";
import { getSettings, inheritSettings } from "../settings";
import { unsafeTrack } from "../unsafeTrack";
import { rejectionError, reservedDataPathError, snapshotDonationError } from "./boundaryErrors";
import { admissionLane, classifyValue } from "./classify";
import {
	constructorPathTargetCount,
	getEnumerableDataChild,
	getRootGraphs,
	recomputeRootGraph,
} from "./constructorPathGuard";
import { createSnapshotPreservingAccessors } from "./snapshotAccessors";

const { proxyStateMap } = unstable_getInternalStates();

export const assertSafeDataPaths = (
	value: unknown,
	path = new Array<string>(),
	activeAncestors = new WeakSet(),
): void => {
	if (typeof value !== "object" || value === null || activeAncestors.has(value)) return;

	activeAncestors.add(value);

	try {
		for (const key of Object.keys(value)) {
			const nextPath = [...path, key];

			if (key === "__proto__" || (key === "prototype" && path[path.length - 1] === "constructor"))
				throw reservedDataPathError(nextPath);

			const descriptor = Reflect.getOwnPropertyDescriptor(value, key);

			if (descriptor && "value" in descriptor) assertSafeDataPaths(descriptor.value, nextPath, activeAncestors);
		}
	} finally {
		activeAncestors.delete(value);
	}
};

let installed = false;

export function installBoundary(): void {
	if (installed) return;

	installed = true;

	unstable_replaceInternalFunction("canProxy", () => (value) => {
		if (typeof value !== "object" || value === null) return false;

		const lane = admissionLane(value);

		if (lane !== "reject") return lane === "track";

		const kind = classifyValue(value);

		if (kind === "plain" || kind === "plainArray") return true;

		throw rejectionError(value, kind);
	});

	unstable_replaceInternalFunction("createSnapshot", () => createSnapshotPreservingAccessors);

	unstable_replaceInternalFunction(
		"createHandler",
		(createHandler) => (isInitializing, addPropListener, removePropListener, notifyUpdate) => {
			let setDepth = 0;

			const handler = createHandler(isInitializing, addPropListener, removePropListener, notifyUpdate);
			const defaultDelete = handler.deleteProperty;
			const defaultSet = handler.set;

			if (!defaultDelete || !defaultSet)
				throw new Error("opshot: valtio default handler is missing a mutation trap");

			return {
				...handler,
				deleteProperty(target, prop) {
					const rootGraphs = getRootGraphs(target);
					const previousChild = rootGraphs.length > 0 ? getEnumerableDataChild(target, prop) : undefined;
					const hadOwn = Object.hasOwn(target, prop);
					const deleted = defaultDelete(target, prop);

					if (deleted && hadOwn && previousChild && !Object.hasOwn(target, prop))
						for (const graph of rootGraphs) recomputeRootGraph(graph);

					return deleted;
				},
				set(target, prop, value, receiver) {
					const assigned: unknown = value;

					if (prop === "__proto__") throw reservedDataPathError(["__proto__"]);

					if (prop === "prototype" && constructorPathTargetCount(target) > 0)
						throw reservedDataPathError(["constructor", "prototype"]);

					if (prop === "constructor" && typeof assigned === "object" && assigned !== null) {
						const prototypeDescriptor = Reflect.getOwnPropertyDescriptor(assigned, "prototype");

						if (prototypeDescriptor?.enumerable) throw reservedDataPathError(["constructor", "prototype"]);
					}

					assertSafeDataPaths(assigned, typeof prop === "string" ? [prop] : []);

					const resolved: unknown =
						typeof assigned === "object" && assigned !== null ? (getUntracked(assigned) ?? assigned) : assigned;

					if (typeof resolved === "object" && resolved !== null) {
						if (getRegisteredTarget(resolved) !== undefined) throw snapshotDonationError(prop);

						inheritSettings(target, resolved);

						if (
							getSettings(target)?.strict === false &&
							!proxyStateMap.has(resolved) &&
							admissionLane(resolved) === "reject"
						)
							unsafeTrack(resolved);
					}

					const rootGraphs = getRootGraphs(target);
					const previousChild = rootGraphs.length > 0 ? getEnumerableDataChild(target, prop) : undefined;
					const previousLength: unknown =
						rootGraphs.length > 0 && Array.isArray(target) && prop === "length"
							? Reflect.get(target, "length")
							: undefined;

					setDepth += 1;

					try {
						const written = defaultSet(target, prop, value, receiver);
						const currentChild = rootGraphs.length > 0 ? getEnumerableDataChild(target, prop) : undefined;
						const currentLength: unknown =
							previousLength === undefined ? undefined : Reflect.get(target, "length");

						if (previousChild !== currentChild || previousLength !== currentLength)
							for (const graph of rootGraphs) recomputeRootGraph(graph);

						return written;
					} finally {
						setDepth -= 1;
					}
				},
				defineProperty(target, prop, descriptor) {
					if (setDepth > 0 || isInitializing()) return Reflect.defineProperty(target, prop, descriptor);

					throw new Error(
						"opshot: defineProperty is not supported on tracked state; define properties in the createMutableState input",
					);
				},
				setPrototypeOf() {
					throw new Error("opshot: setPrototypeOf is not supported on tracked state");
				},
			};
		},
	);
}
