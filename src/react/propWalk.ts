import { isState } from "../isState";
import { peelReadProxy } from "../peelReadProxy";
import { walkDataEntries, type DataEntry } from "../utils/dataEntries";
import { admissionLane, unfrozenAdmissionLane } from "../valtio/classify";

export interface SubstitutionResult<T> {
	readonly props: T;
	readonly sources: ReadonlyArray<object>;
}

type WalkMode = "entry" | "nested";

type ChildRole = "state" | "descend" | "skip";

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

const isReactOwnNode = (value: object): boolean =>
	"$$typeof" in value || (typeof Node !== "undefined" && value instanceof Node);

const childRole = (value: unknown, writable: boolean, mode: WalkMode): ChildRole => {
	if (typeof value !== "object" || value === null) return "skip";

	if (isReactOwnNode(value)) return "skip";

	if (mode === "nested" && !writable) return "skip";

	if (admissionLane(value) === "untracked") return "skip";

	if (isState(value)) return "state";

	if (admissionLane(value) === "tracked") return "descend";

	return "skip";
};

const readVerdict = (container: object, pass: DiscoveryPass): ReadonlySet<string> =>
	pass.verdicts.get(container) ?? stateKeysByContainer.get(container) ?? noStateKeys;

const createDiscoveryPass = (): DiscoveryPass => ({
	entriesByContainer: new Map<object, ReadonlyArray<DataEntry>>(),
	verdicts: new Map<object, Set<string>>(),
	inProgress: new Set<object>(),
	relaxable: new Set<object>(),
});

function visitContainer(container: object, pass: DiscoveryPass, mode: WalkMode): boolean {
	if (mode === "nested" && stateKeysByContainer.has(container)) return false;

	if (pass.inProgress.has(container)) return true;

	if (pass.verdicts.has(container)) return pass.relaxable.has(container);

	pass.inProgress.add(container);

	const entries = walkDataEntries(container);
	const keys = new Set<string>();
	let dependedOnBackEdge = false;

	pass.entriesByContainer.set(container, entries);

	for (const entry of entries) {
		const role = childRole(entry.value, entry.writable, mode);

		if (role === "state") {
			keys.add(entry.key);

			continue;
		}

		if (role !== "descend") continue;

		const child = entry.value;

		if (typeof child !== "object" || child === null) continue;

		if (visitContainer(child, pass, "nested")) dependedOnBackEdge = true;

		if (readVerdict(child, pass).size > 0) keys.add(entry.key);
	}

	pass.inProgress.delete(container);
	pass.verdicts.set(container, keys);

	if (dependedOnBackEdge) pass.relaxable.add(container);

	return dependedOnBackEdge;
}

function relaxVerdicts(pass: DiscoveryPass, entryContainer?: object): void {
	let gained = true;

	while (gained) {
		gained = false;

		for (const container of pass.relaxable) {
			const keys = pass.verdicts.get(container);
			const entries = pass.entriesByContainer.get(container);

			if (keys === undefined || entries === undefined) continue;

			for (const entry of entries) {
				if (keys.has(entry.key)) continue;

				if (childRole(entry.value, entry.writable, container === entryContainer ? "entry" : "nested") !== "descend")
					continue;

				const child = entry.value;

				if (typeof child !== "object" || child === null) continue;

				if (readVerdict(child, pass).size === 0) continue;

				keys.add(entry.key);

				gained = true;
			}
		}
	}
}

const cacheNestedVerdicts = (pass: DiscoveryPass, skip?: object): void => {
	for (const [visited, keys] of pass.verdicts) {
		if (visited === skip) continue;

		stateKeysByContainer.set(visited, keys);
	}
};

export function discoverStateKeys(container: object): ReadonlySet<string> {
	const cached = stateKeysByContainer.get(container);

	if (cached !== undefined) return cached;

	if (isReactOwnNode(container)) return noStateKeys;

	if (admissionLane(container) !== "tracked") return noStateKeys;

	const pass = createDiscoveryPass();

	visitContainer(container, pass, "nested");
	relaxVerdicts(pass);
	cacheNestedVerdicts(pass);

	return pass.verdicts.get(container) ?? noStateKeys;
}

function substituteContainer(
	container: object,
	substitution: Substitution,
	wrap: (source: object) => object,
	mode: WalkMode,
): object {
	const rebuilt = substitution.rebuiltByContainer.get(container);

	if (rebuilt !== undefined) return rebuilt;

	let stateKeys: ReadonlySet<string>;

	if (mode === "nested") {
		stateKeys = discoverStateKeys(container);
	} else {
		const pass = createDiscoveryPass();

		visitContainer(container, pass, "entry");
		relaxVerdicts(pass, container);
		cacheNestedVerdicts(pass, container);
		stateKeys = pass.verdicts.get(container) ?? noStateKeys;
	}

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
		const role = childRole(value, descriptor.writable === true, mode);

		if (role === "state") {
			const source = peelReadProxy(value);

			if (typeof source !== "object" || source === null) continue;

			if (!substitution.visitedSources.has(source)) {
				substitution.visitedSources.add(source);
				substitution.sources.push(source);
			}

			descriptors[key] = { ...descriptor, value: wrap(source) };

			continue;
		}

		if (role !== "descend") continue;

		if (typeof value !== "object" || value === null) continue;

		descriptors[key] = { ...descriptor, value: substituteContainer(value, substitution, wrap, "nested") };
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

	if (isReactOwnNode(root) || unfrozenAdmissionLane(root) !== "tracked") {
		return { props: root, sources: substitution.sources };
	}

	return { props: substituteContainer(root, substitution, wrap, "entry") as T, sources: substitution.sources };
}
