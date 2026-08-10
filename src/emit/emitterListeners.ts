import { snapshot } from "valtio/vanilla";
import { armEmitter, disarmEmitter, reportBareDiff } from "./emitterBare";
import {
	deleteEmitter,
	getOrCreateEmitter,
	hasListeners,
	type EmitterRecord,
	type GroupDeliver,
	type GroupListeners,
	type StateDeliver,
} from "./emitterRegistry";
import { resolveWriteProxy } from "./resolveWriteProxy";

interface StateBinding {
	readonly record: EmitterRecord;
	readonly listener: Function;
	readonly channelId: object | undefined;
	readonly writeProxy: object;
}

interface GroupBinding {
	readonly listeners: GroupListeners;
	readonly listener: Function;
	readonly channelId: object | undefined;
}

const bindings = new WeakMap<() => void, StateBinding | GroupBinding>();

export const holdsBinding = (unsubscribe: () => void): boolean => bindings.has(unsubscribe);

export function addStateListener(
	state: object,
	listener: Function,
	channelId: object | undefined,
	deliver: StateDeliver,
): () => void {
	const writeProxy = resolveWriteProxy(state);
	const record = getOrCreateEmitter(writeProxy, undefined, writeProxy);

	if (record.disarmEmission === undefined && record.groupChain === undefined) {
		armEmitter(record);
	}

	if (!hasListeners(record)) {
		record.lastReported = snapshot(record.writeProxy);
	}

	let byChannel = record.listeners.get(listener);

	if (byChannel === undefined) {
		byChannel = new Map();
		record.listeners.set(listener, byChannel);
	}

	byChannel.set(channelId, deliver);

	const unsubscribe = (): void => {
		const held = bindings.get(unsubscribe) as StateBinding | undefined;

		if (held === undefined) return;

		const channels = held.record.listeners.get(held.listener);

		if (channels?.has(held.channelId) !== true) {
			bindings.delete(unsubscribe);

			return;
		}

		reportBareDiff(held.record);
		channels.delete(held.channelId);

		if (channels.size === 0) held.record.listeners.delete(held.listener);

		if (held.record.groupChain === undefined && held.record.listeners.size === 0) {
			disarmEmitter(held.record);
			deleteEmitter(held.writeProxy);
		}

		bindings.delete(unsubscribe);
	};

	bindings.set(unsubscribe, { record, listener, channelId, writeProxy });

	return unsubscribe;
}

export function addGroupListener(
	groupListeners: GroupListeners,
	listener: Function,
	channelId: object | undefined,
	deliver: GroupDeliver,
): () => void {
	let byChannel = groupListeners.get(listener);

	if (byChannel === undefined) {
		byChannel = new Map();
		groupListeners.set(listener, byChannel);
	}

	byChannel.set(channelId, deliver);

	const unsubscribe = (): void => {
		const held = bindings.get(unsubscribe) as GroupBinding | undefined;

		if (held === undefined) return;

		const channels = held.listeners.get(held.listener);

		if (channels?.has(held.channelId) !== true) {
			bindings.delete(unsubscribe);

			return;
		}

		channels.delete(held.channelId);

		if (channels.size === 0) held.listeners.delete(held.listener);

		bindings.delete(unsubscribe);
	};

	bindings.set(unsubscribe, { listeners: groupListeners, listener, channelId });

	return unsubscribe;
}
