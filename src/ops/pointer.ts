export const toPointer = (path: ReadonlyArray<string | number>): string => {
	if (path.length === 0) return "";

	return `/${path.map((segment) => String(segment).replaceAll("~", "~0").replaceAll("/", "~1")).join("/")}`;
};

// RFC 6901 unescape order matters: ~1 before ~0, so "~01" round-trips to "~1" the string, never "/" the separator.
export const parsePointer = (pointer: string): Array<string> => {
	if (pointer === "") return [];

	return pointer
		.split("/")
		.slice(1)
		.map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"));
};
