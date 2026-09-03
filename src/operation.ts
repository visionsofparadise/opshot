export interface Operation {
	readonly node: object;
	readonly key: string;
	readonly before?: unknown;
	readonly after?: unknown;
	readonly meta: unknown;
}
