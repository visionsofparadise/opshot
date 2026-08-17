class ObjectRootSnapshotError extends Error {
	constructor() {
		super("opshot: state snapshots must have an object root");
		this.name = "ObjectRootSnapshotError";
	}
}

export const requireObjectSnapshot = (value: unknown): object => {
	if (value !== null && (typeof value === "object" || typeof value === "function")) return value;

	throw new ObjectRootSnapshotError();
};
