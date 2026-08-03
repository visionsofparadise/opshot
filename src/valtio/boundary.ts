import { getUntracked } from "proxy-compare";
import { unstable_getInternalStates, unstable_replaceInternalFunction } from "valtio/vanilla";
import { getRegisteredTarget } from "../identity";
import { unwrapWrapper } from "../react/resolveWrapper";
import { getSettings, inheritSettings } from "../settings";
import { unsafeTrack } from "../unsafeTrack";
import { rejectionError, reservedDataPathError, snapshotDonationError } from "./boundaryErrors";
import { admissionLane, classifyValue, type AdmissionLane } from "./classify";
import { createSnapshotPreservingAccessors } from "./snapshotAccessors";

const { proxyStateMap } = unstable_getInternalStates();

const certifyAdmission = (value: object, path?: ReadonlyArray<string>): AdmissionLane => {
	const lane = admissionLane(value);

	if (lane !== "reject") return lane;

	const kind = classifyValue(value);

	if (kind === "plain" || kind === "plainArray") return "track";

	throw rejectionError(value, kind, path);
};

const resolveAssigned = (value: unknown): unknown => {
	let current: unknown = value;

	while (typeof current === "object" && current !== null) {
		const untracked: unknown = getUntracked(current);
		const next: unknown = unwrapWrapper(untracked ?? current);

		if (next === current) break;

		current = next;
	}

	return current;
};

const CERTIFYING_VISIT = 1;
const UNCERTIFIED_VISIT = 2;

const walkDataPaths = (
	value: unknown,
	path: Array<string> | undefined,
	visits: Map<object, number>,
	certifying: boolean,
): void => {
	if (typeof value !== "object" || value === null) return;

	const visit = certifying ? CERTIFYING_VISIT : UNCERTIFIED_VISIT;
	const seen = visits.get(value) ?? 0;

	if ((seen & visit) !== 0) return;

	visits.set(value, seen | visit);

	for (const key of Object.keys(value)) {
		const nextPath = path === undefined ? undefined : [...path, key];

		if (key === "__proto__") throw reservedDataPathError(nextPath ?? [key]);

		const descriptor = Reflect.getOwnPropertyDescriptor(value, key);

		if (!descriptor || !("value" in descriptor)) continue;

		const child: unknown = descriptor.value;
		const reachable = certifying && descriptor.writable === true && typeof child === "object" && child !== null;
		const certifyBelow = reachable && !proxyStateMap.has(child) && certifyAdmission(child, nextPath) === "track";

		walkDataPaths(child, nextPath, visits, certifyBelow);
	}
};

export const assertSafeDataPaths = (
	value: unknown,
	path: Array<string> | undefined,
	visits: Map<object, number>,
	strict: boolean,
): void => {
	walkDataPaths(value, path, visits, strict);
};

let installed = false;

export function installBoundary(): void {
	if (installed) return;

	installed = true;

	unstable_replaceInternalFunction("canProxy", () => (value) => {
		if (typeof value !== "object" || value === null) return false;

		return certifyAdmission(value) === "track";
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
				set(target, prop, value, receiver) {
					const assigned: unknown = value;

					if (prop === "__proto__") throw reservedDataPathError(["__proto__"]);

					const resolved: unknown = resolveAssigned(assigned);

					const location = typeof prop === "string" ? [prop] : [];
					const strict = getSettings(target)?.strict !== false;
					const certifyAssigned =
						strict && typeof resolved === "object" && resolved !== null
							? admissionLane(resolved) === "track"
							: strict;

					assertSafeDataPaths(resolved, isInitializing() ? undefined : location, new Map(), certifyAssigned);

					if (typeof resolved === "object" && resolved !== null) {
						if (getRegisteredTarget(resolved) !== undefined) throw snapshotDonationError(prop);

						inheritSettings(target, resolved);

						if (
							getSettings(target)?.strict === false &&
							!proxyStateMap.has(resolved) &&
							admissionLane(resolved) === "reject"
						)
							unsafeTrack(resolved);

						if (!proxyStateMap.has(resolved)) certifyAdmission(resolved, isInitializing() ? undefined : location);
					}

					setDepth += 1;

					try {
						return defaultSet(target, prop, resolved, receiver);
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
				preventExtensions() {
					throw new Error(
						"opshot: preventExtensions is not supported on tracked state; freeze the value before it enters state (a non-extensible target silently drops tracked writes)",
					);
				},
			};
		},
	);
}
