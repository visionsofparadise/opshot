import { markToTrack } from "proxy-compare";
import { unstable_getInternalStates, unstable_replaceInternalFunction, type INTERNAL_Op } from "valtio/vanilla";

import { attach, isTrackedWrapper, isWrapperCommand, wrapperOpTag } from "./trackedWrapper";

// refSet is the only runtime marker ref() leaves on a value; valtio exposes it nowhere else.
const { refSet, proxyStateMap, snapCache } = unstable_getInternalStates();

export type ValueKind = "plain" | "plainArray" | "arraySubclass" | "cleanClass" | "privateClass" | "nativeClass";

const sourceCache = new WeakMap<Function, string>();

const readSource = (constructor: Function): string => {
	const cached = sourceCache.get(constructor);

	if (cached !== undefined) return cached;

	const source = Function.prototype.toString.call(constructor);

	sourceCache.set(constructor, source);

	return source;
};

const classifyChain = (initialConstructor: unknown): ValueKind => {
	let sawNativeSource = false;
	let current = initialConstructor;

	while (typeof current === "function" && current !== Object && current !== Array && current !== Function.prototype) {
		const source = readSource(current);

		if (source.includes("#")) return "privateClass";
		if (source.includes("[native code]")) sawNativeSource = true;

		current = Reflect.getPrototypeOf(current);
	}

	return sawNativeSource ? "nativeClass" : "cleanClass";
};

export function classifyValue(value: object): ValueKind {
	const prototype: unknown = Object.getPrototypeOf(value);

	if (Array.isArray(value)) return prototype === Array.prototype || prototype === null ? "plainArray" : "arraySubclass";
	if (prototype === Object.prototype || prototype === null) return "plain";

	return classifyChain(value.constructor);
}

const ignoreOption = "ignore(value) to store it by reference, untracked";

export const constructorName = (candidate: unknown): string => (typeof candidate === "function" && candidate.name !== "" ? candidate.name : "Object");

const boundaryError = (className: string, reason: string, options: Array<string>): Error =>
	new Error(`opshot: ${className} cannot be tracked (${reason}). Options: ${options.join("; ")}.`);

const slotContainerError = (className: string, trackedName: string): Error =>
	boundaryError(className, "its state lives in internal slots", [`use ${trackedName} for a tracked equivalent`, ignoreOption]);

const arraySubclassError = (className: string): Error => boundaryError(className, "array subclasses lose their prototype in snapshots", [ignoreOption]);

const cleanClassError = (className: string): Error => boundaryError(className, "class instances cannot be tracked", [ignoreOption]);

const privateClassError = (className: string): Error => boundaryError(className, "its state is hidden in private fields", [ignoreOption]);

const nativeClassError = (className: string): Error => boundaryError(className, "its state is hidden in internal slots", [ignoreOption]);

const rejectionError = (value: object, kind: "arraySubclass" | "cleanClass" | "privateClass" | "nativeClass"): Error => {
	const className = constructorName(value.constructor);
	const prototype: unknown = Object.getPrototypeOf(value);

	if (prototype === Map.prototype) return slotContainerError(className, "TrackedMap");
	if (prototype === Set.prototype) return slotContainerError(className, "TrackedSet");
	if (prototype === Date.prototype) return slotContainerError(className, "TrackedDate");

	switch (kind) {
		case "arraySubclass":
			return arraySubclassError(className);
		case "cleanClass":
			return cleanClassError(className);
		case "privateClass":
			return privateClassError(className);
		case "nativeClass":
			return nativeClassError(className);
	}
};

// Reimplements valtio's createSnapshotDefault (vanilla.mjs) with one added branch: own accessor
// descriptors copy as live getters/setters instead of materializing via Reflect.get. Everything
// else is kept faithful -- snapCache seeding BEFORE the property walk (snapshot identity and
// structural sharing depend on it), markToTrack, refSet handling, configurable-true non-writable
// data descriptors, and child-snapshot recursion, which must call THIS function by name since the
// default recurses by its own name and would otherwise rebuild children without the accessor branch.
const createSnapshotPreservingAccessors = <T extends object>(target: T, version: number): T => {
	const cached = snapCache.get(target);

	if (cached?.[0] === version) return cached[1] as T;

	const snap: object = Array.isArray(target) ? [] : (Object.create(Reflect.getPrototypeOf(target)) as object);

	markToTrack(snap, true);
	snapCache.set(target, [version, snap]);

	for (const key of Reflect.ownKeys(target)) {
		if (Object.getOwnPropertyDescriptor(snap, key)) continue;

		const descriptor = Reflect.getOwnPropertyDescriptor(target, key);

		if (!descriptor) continue;

		if (descriptor.get || descriptor.set) {
			Object.defineProperty(snap, key, {
				get: descriptor.get,
				set: descriptor.set,
				enumerable: descriptor.enumerable,
				configurable: true,
			});

			continue;
		}

		const value: unknown = Reflect.get(target, key);
		const snapshotDescriptor: PropertyDescriptor = { value, enumerable: descriptor.enumerable, configurable: true };

		if (typeof value === "object" && value !== null) {
			if (refSet.has(value)) {
				markToTrack(value, false);
			} else {
				const childState = proxyStateMap.get(value);

				if (childState) snapshotDescriptor.value = createSnapshotPreservingAccessors(childState[0], childState[1]());
			}
		}

		Object.defineProperty(snap, key, snapshotDescriptor);
	}

	return snap as T;
};

type NotifyUpdate = (op: INTERNAL_Op | undefined) => void;

// Which (notifyUpdate, key) bindings a wrapper already holds a notifier for: valtio's notifyUpdate is
// minted once per proxy, so the pair identifies a parent-proxy/key binding, and re-assigning the same
// wrapper there (including delete-then-reassign) must not attach a second, double-emitting notifier.
const wrapperNotifierKeys = new WeakMap<object, WeakMap<NotifyUpdate, Set<string>>>();

const attachWrapperNotifier = (wrapper: object, key: string, notifyUpdate: NotifyUpdate): void => {
	let byNotifier = wrapperNotifierKeys.get(wrapper);

	if (!byNotifier) {
		byNotifier = new WeakMap();
		wrapperNotifierKeys.set(wrapper, byNotifier);
	}

	let keys = byNotifier.get(notifyUpdate);

	if (!keys) {
		keys = new Set();
		byNotifier.set(notifyUpdate, keys);
	}

	if (keys.has(key)) return;

	keys.add(key);

	attach(wrapper, {
		notify: (commandOp) => {
			if (!isWrapperCommand(commandOp)) throw new Error("opshot: malformed tracked-wrapper command");

			// Probe 1.4 pins that valtio's notification chain path-prefixes and propagates any op-shaped
			// array; INTERNAL_Op's union just doesn't name the custom shape, so the widening is the seam's
			// runtime contract, not a workaround.
			notifyUpdate([wrapperOpTag, [key, ...commandOp.path], commandOp.payload] as unknown as INTERNAL_Op);
		},
	});
};

let installed = false;

// Reentrancy counter, not a boolean: valtio's set trap ends in Reflect.set(target, prop, value,
// receiver=proxy), which per ECMAScript routes every ordinary write through the proxy's own
// [[DefineOwnProperty]] (OrdinarySetWithOwnDescriptor) -- a boolean guard would be reset mid-write
// by a nested child-proxy-creating set. See plan-value-model.md Phase 1 action 1.2's Deviation.
let setDepth = 0;

export function installBoundary(): void {
	if (installed) return;

	installed = true;

	unstable_replaceInternalFunction("canProxy", () => (value) => {
		if (typeof value !== "object" || value === null) return false;
		if (refSet.has(value)) return false;
		if (isTrackedWrapper(value)) return false;

		const kind = classifyValue(value);

		if (kind === "plain" || kind === "plainArray") return !Object.isFrozen(value);

		throw rejectionError(value, kind);
	});

	unstable_replaceInternalFunction("createSnapshot", () => createSnapshotPreservingAccessors);

	unstable_replaceInternalFunction(
		"createHandler",
		(createHandler) => (isInitializing, addPropListener, removePropListener, notifyUpdate) => {
			const handler = createHandler(isInitializing, addPropListener, removePropListener, notifyUpdate);
			const defaultSet = handler.set;

			if (!defaultSet) throw new Error("opshot: valtio default handler is missing its set trap");

			return {
				...handler,
				set(target, prop, value, receiver) {
					// Symbol keys are the ride-along (not-data) channel and an ignore()d wrapper is fully
					// outside the system, so neither binding gets a notifier. ProxyHandler types value as
					// any; the unknown local restores narrowing.
					const assigned: unknown = value;

					if (typeof prop === "string" && isTrackedWrapper(assigned) && !refSet.has(assigned)) attachWrapperNotifier(assigned, prop, notifyUpdate);

					setDepth += 1;

					try {
						return defaultSet(target, prop, value, receiver);
					} finally {
						setDepth -= 1;
					}
				},
				defineProperty(target, prop, descriptor) {
					if (setDepth > 0 || isInitializing()) return Reflect.defineProperty(target, prop, descriptor);

					throw new Error("opshot: defineProperty is not supported on tracked state; define properties in the createState literal");
				},
				setPrototypeOf() {
					throw new Error("opshot: setPrototypeOf is not supported on tracked state");
				},
			};
		},
	);
}
