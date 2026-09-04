import type { Handle } from "./handle";

export interface Membership {
	edges: number;
	exempt: boolean;
	readonly keys: Set<string>;
}

export interface NodeRecord {
	readonly raw: object;
	readonly proxy: object;
	readonly memberships: Map<Handle, Membership>;
}

const byRaw = new WeakMap<object, NodeRecord>();
const byProxy = new WeakMap<object, NodeRecord>();

let proxyHandler: ProxyHandler<object> | undefined;

export function installProxyHandler(handler: ProxyHandler<object>): void {
	proxyHandler = handler;
}

export function recordOf(value: object): NodeRecord | undefined {
	return byRaw.get(value) ?? byProxy.get(value);
}

export function rawOf(value: object): object {
	return recordOf(value)?.raw ?? value;
}

export function proxyOf(raw: object): object {
	const existing = recordOf(raw);

	if (existing !== undefined) return existing.proxy;

	if (proxyHandler === undefined) throw new Error("opshot: proxy handler is not installed");

	const proxy = new Proxy(raw, proxyHandler);
	const record: NodeRecord = { raw, proxy, memberships: new Map() };

	byRaw.set(raw, record);
	byProxy.set(proxy, record);

	return proxy;
}

export function handlesOf(node: object): Array<Handle> {
	return membershipsOf(node).map(([handle]) => handle);
}

export function membershipsOf(node: object): Array<[Handle, Membership]> {
	const record = recordOf(rawOf(node));

	if (record === undefined) return [];

	const memberships = new Array<[Handle, Membership]>();

	for (const [handle, membership] of record.memberships) {
		if (membership.edges > 0) memberships.push([handle, membership]);
	}

	return memberships;
}
