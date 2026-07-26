import { constructorName } from "../utils/constructorName";

const ignoreOption = "ignore(value) to store it by reference, untracked";
const unsafeTrackDataOption = "unsafeTrack(value) to track its data anyway";
const unsafeTrackPrivateOption =
	"unsafeTrack(value) tracks public fields while private methods throw on snapshots and undo drops that state";
const unsafeTrackSlotOption =
	"unsafeTrack(value) tracks public fields while slot methods throw on snapshots and undo drops that state";
const unsafeTrackLossyOption = "unsafeTrack(value) to track it lossily";

const boundaryError = (className: string, reason: string, options: Array<string>): Error =>
	new Error(
		`opshot: ${className} cannot be tracked (${reason}). Options:\n${options.map((option) => `- ${option}`).join("\n")}`,
	);

const slotContainerError = (className: string, trackedName: string): Error =>
	boundaryError(className, "its state lives in internal slots", [
		`use ${trackedName} for a tracked equivalent`,
		unsafeTrackLossyOption,
		ignoreOption,
	]);

const arraySubclassError = (className: string): Error =>
	boundaryError(className, "array subclasses lose their prototype in snapshots", [
		unsafeTrackDataOption,
		ignoreOption,
	]);

const cleanClassError = (className: string): Error =>
	boundaryError(className, "arrow-method writes won't be tracked", [unsafeTrackDataOption, ignoreOption]);

const privateClassError = (className: string): Error =>
	boundaryError(className, "its state is hidden in private fields", [unsafeTrackPrivateOption, ignoreOption]);

const nativeClassError = (className: string): Error =>
	boundaryError(className, "its state is hidden in internal slots", [unsafeTrackSlotOption, ignoreOption]);

export const snapshotDonationError = (key: string | symbol): Error =>
	new Error(
		`opshot: cannot assign a snapshot generation at "${String(key)}": a snapshot generation is a read-view, and assigning it creates a dead region. Clone the value, or replay through applyOps.`,
	);

export const reservedDataPathError = (path: ReadonlyArray<string>): Error =>
	new Error(`opshot: reserved data path /${path.join("/")}`);

const inheritsFromPrototype = (value: object, prototype: object): boolean => {
	for (let current = Reflect.getPrototypeOf(value); current !== null; current = Reflect.getPrototypeOf(current))
		if (current === prototype) return true;

	return false;
};

export const rejectionError = (
	value: object,
	kind: "arraySubclass" | "cleanClass" | "privateClass" | "nativeClass",
): Error => {
	const className = constructorName(value.constructor);

	if (inheritsFromPrototype(value, Map.prototype)) return slotContainerError(className, "TrackedMap");

	if (inheritsFromPrototype(value, Set.prototype)) return slotContainerError(className, "TrackedSet");

	if (inheritsFromPrototype(value, Date.prototype)) return slotContainerError(className, "TrackedDate");

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
