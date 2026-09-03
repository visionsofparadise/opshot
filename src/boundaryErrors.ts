import { constructorName } from "./utils/constructorName";

const ignoreOption = "ignore(value) to store it by reference, untracked";
const unsafeTrackDataOption = "unsafeTrack(value) to track its data anyway";
const unsafeTrackPrivateOption = "unsafeTrack(value) tracks public fields while private methods stay untracked";
const unsafeTrackSlotOption = "unsafeTrack(value) tracks public fields while slot methods stay untracked";
const unsafeTrackLossyOption = "unsafeTrack(value) to track it lossily";

const locationClause = (path: ReadonlyArray<string> | undefined): string =>
	path === undefined || path.length === 0 ? "" : ` at /${path.join("/")}`;

const boundaryError = (
	className: string,
	reason: string,
	options: Array<string>,
	path: ReadonlyArray<string> | undefined,
): Error =>
	new Error(
		`opshot: ${className}${locationClause(path)} cannot be tracked (${reason}). Options:\n${options.map((option) => `- ${option}`).join("\n")}`,
	);

const slotContainerError = (className: string, trackedName: string, path: ReadonlyArray<string> | undefined): Error =>
	boundaryError(
		className,
		"its state lives in internal slots",
		[`use ${trackedName} for a tracked equivalent`, unsafeTrackLossyOption, ignoreOption],
		path,
	);

const arraySubclassError = (className: string, path: ReadonlyArray<string> | undefined): Error =>
	boundaryError(className, "array subclasses are not plain arrays", [unsafeTrackDataOption, ignoreOption], path);

const cleanClassError = (className: string, path: ReadonlyArray<string> | undefined): Error =>
	boundaryError(className, "arrow-method writes won't be tracked", [unsafeTrackDataOption, ignoreOption], path);

const privateClassError = (className: string, path: ReadonlyArray<string> | undefined): Error =>
	boundaryError(className, "its state is hidden in private fields", [unsafeTrackPrivateOption, ignoreOption], path);

const nativeClassError = (className: string, path: ReadonlyArray<string> | undefined): Error =>
	boundaryError(className, "its state is hidden in internal slots", [unsafeTrackSlotOption, ignoreOption], path);

export const nonWritablePropertyError = (value: object, path: ReadonlyArray<string>): Error =>
	boundaryError(
		constructorName(value.constructor),
		"a non-writable property's interior is silently mutable and untracked",
		["make the property writable", "ignore(value) to declare the escape"],
		path,
	);

const inheritsFromPrototype = (value: object, prototype: object): boolean => {
	for (let current = Reflect.getPrototypeOf(value); current !== null; current = Reflect.getPrototypeOf(current))
		if (current === prototype) return true;

	return false;
};

export const rejectionError = (
	value: object,
	kind: "arraySubclass" | "cleanClass" | "privateClass" | "nativeClass",
	path?: ReadonlyArray<string>,
): Error => {
	const className = constructorName(value.constructor);

	if (inheritsFromPrototype(value, Map.prototype)) return slotContainerError(className, "TrackedMap", path);

	if (inheritsFromPrototype(value, Set.prototype)) return slotContainerError(className, "TrackedSet", path);

	if (inheritsFromPrototype(value, Date.prototype)) return slotContainerError(className, "TrackedDate", path);

	switch (kind) {
		case "arraySubclass":
			return arraySubclassError(className, path);
		case "cleanClass":
			return cleanClassError(className, path);
		case "privateClass":
			return privateClassError(className, path);
		case "nativeClass":
			return nativeClassError(className, path);
	}
};
