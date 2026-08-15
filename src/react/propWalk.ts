import { unstable_getInternalStates } from "valtio/vanilla";
import { pendingIgnore } from "../ignore";
import { isState } from "../isState";
import { peelReadProxy } from "../peelReadProxy";
import { classifyValue } from "../valtio/classify";

const { refSet } = unstable_getInternalStates();

export interface SubstitutionResult<T> {
	readonly props: T;
	readonly sources: ReadonlyArray<object>;
}

type DataEntry = readonly [string, unknown];

interface DiscoveryPass {
	readonly entriesByContainer: Map<object, ReadonlyArray<DataEntry>>;
	readonly verdicts: Map<object, Set<string>>;
	readonly inProgress: Set<object>;
	readonly relaxable: Set<object>;
}

interface Substitution {
	readonly rebuiltByContainer: Map<object, object>;
	readonly sources: Array<object>;
	readonly visitedSources: Set<object>;
}

const stateKeysByContainer = new WeakMap<object, ReadonlySet<string>>();

const noStateKeys: ReadonlySet<string> = new Set<string>();

const isSearchableContainer = (value: unknown): value is object => {
	if (typeof value !== "object" || value === null) return false;

	if ("$$typeof" in value) return false;

	if (refSet.has(value) || pendingIgnore.has(value)) return false;

	const kind = classifyValue(value);

	return kind === "plain" || kind === "plainArray" || kind === "cleanClass";
};

const readDataEntries = (container: object): ReadonlyArray<DataEntry> => {
	const entries: Array<DataEntry> = [];

	for (const key of Object.keys(container)) {
		if (key.startsWith("__react")) continue;

		const descriptor = Reflect.getOwnPropertyDescriptor(container, key);

		if (!descriptor || !("value" in descriptor)) continue;

		const value: unknown = descriptor.value;

		entries.push([key, value]);
	}

	return entries;
};

const readVerdict = (container: object, pass: DiscoveryPass): ReadonlySet<string> =>
	pass.verdicts.get(container) ?? stateKeysByContainer.get(container) ?? noStateKeys;

function visitContainer(container: object, pass: DiscoveryPass): boolean {
	if (stateKeysByContainer.has(container)) return false;

	if (pass.inProgress.has(container)) return true;

	if (pass.verdicts.has(container)) return pass.relaxable.has(container);

	pass.inProgress.add(container);

	const entries = readDataEntries(container);
	const keys = new Set<string>();
	let dependedOnBackEdge = false;

	pass.entriesByContainer.set(container, entries);

	for (const [key, value] of entries) {
		if (isState(value)) {
			keys.add(key);

			continue;
		}

		if (!isSearchableContainer(value)) continue;

		if (visitContainer(value, pass)) dependedOnBackEdge = true;

		if (readVerdict(value, pass).size > 0) keys.add(key);
	}

	pass.inProgress.delete(container);
	pass.verdicts.set(container, keys);

	if (dependedOnBackEdge) pass.relaxable.add(container);

	return dependedOnBackEdge;
}

function relaxVerdicts(pass: DiscoveryPass): void {
	let gained = true;

	while (gained) {
		gained = false;

		for (const container of pass.relaxable) {
			const keys = pass.verdicts.get(container);
			const entries = pass.entriesByContainer.get(container);

			if (keys === undefined || entries === undefined) continue;

			for (const [key, value] of entries) {
				if (keys.has(key)) continue;

				if (!isSearchableContainer(value)) continue;

				if (readVerdict(value, pass).size === 0) continue;

				keys.add(key);

				gained = true;
			}
		}
	}
}

export function discoverStateKeys(container: object): ReadonlySet<string> {
	const cached = stateKeysByContainer.get(container);

	if (cached !== undefined) return cached;

	if (!isSearchableContainer(container)) return noStateKeys;

	const pass: DiscoveryPass = {
		entriesByContainer: new Map<object, ReadonlyArray<DataEntry>>(),
		verdicts: new Map<object, Set<string>>(),
		inProgress: new Set<object>(),
		relaxable: new Set<object>(),
	};

	visitContainer(container, pass);
	relaxVerdicts(pass);

	for (const [visited, keys] of pass.verdicts) stateKeysByContainer.set(visited, keys);

	return pass.verdicts.get(container) ?? noStateKeys;
}

function substituteContainer(container: object, substitution: Substitution, wrap: (source: object) => object): object {
	const rebuilt = substitution.rebuiltByContainer.get(container);

	if (rebuilt !== undefined) return rebuilt;

	const stateKeys = discoverStateKeys(container);

	if (stateKeys.size === 0) {
		substitution.rebuiltByContainer.set(container, container);

		return container;
	}

	const clone: object = Array.isArray(container) ? [] : {};

	Reflect.setPrototypeOf(clone, Reflect.getPrototypeOf(container));
	substitution.rebuiltByContainer.set(container, clone);

	const descriptors = Object.getOwnPropertyDescriptors(container);

	for (const key of stateKeys) {
		const descriptor = descriptors[key];

		if (descriptor === undefined || !("value" in descriptor)) continue;

		const value: unknown = descriptor.value;

		if (isState(value)) {
			const source = peelReadProxy(value);

			if (typeof source !== "object" || source === null) continue;

			if (!substitution.visitedSources.has(source)) {
				substitution.visitedSources.add(source);
				substitution.sources.push(source);
			}

			descriptors[key] = { ...descriptor, value: wrap(source) };

			continue;
		}

		if (!isSearchableContainer(value)) continue;

		descriptors[key] = { ...descriptor, value: substituteContainer(value, substitution, wrap) };
	}

	Object.defineProperties(clone, descriptors);

	return clone;
}

export function substituteStates<T extends object>(root: T, wrap: (source: object) => object): SubstitutionResult<T> {
	const substitution: Substitution = {
		rebuiltByContainer: new Map<object, object>(),
		sources: [],
		visitedSources: new Set<object>(),
	};

	if (!isSearchableContainer(root)) return { props: root, sources: substitution.sources };

	return { props: substituteContainer(root, substitution, wrap) as T, sources: substitution.sources };
}
