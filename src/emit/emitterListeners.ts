import { armWatchdog, disarmWatchdog, settlePendingBare } from "./emitterBare";
import {
	deleteEmitter,
	getOrCreateEmitter,
	type GroupListener,
	type GroupListeners,
	type StateListener,
} from "./emitterRegistry";
import { resolveEmitterTarget } from "./resolveEmitterTarget";

export function addStateListener(
	state: object,
	listener: Function,
	channelId: object | undefined,
	deliver: StateListener,
): () => void {
	const target = resolveEmitterTarget(state);
	const record = getOrCreateEmitter(target);

	if (record.disarm === undefined && record.groupListeners === undefined) {
		armWatchdog(record);
	}

	let byChannel = record.listeners.get(listener);

	if (byChannel === undefined) {
		byChannel = new Map();
		record.listeners.set(listener, byChannel);
	}

	byChannel.set(channelId, deliver);

	return () => {
		const channels = record.listeners.get(listener);

		if (channels?.has(channelId) !== true) return;

		settlePendingBare(record);
		channels.delete(channelId);

		if (channels.size === 0) record.listeners.delete(listener);

		if (record.groupListeners === undefined && record.listeners.size === 0) {
			disarmWatchdog(record);
			deleteEmitter(target);
		}
	};
}

export function addGroupListener(
	groupListeners: GroupListeners,
	listener: Function,
	channelId: object | undefined,
	deliver: GroupListener,
): () => void {
	let byChannel = groupListeners.get(listener);

	if (byChannel === undefined) {
		byChannel = new Map();
		groupListeners.set(listener, byChannel);
	}

	byChannel.set(channelId, deliver);

	return () => {
		const channels = groupListeners.get(listener);

		if (channels?.has(channelId) !== true) return;

		channels.delete(channelId);

		if (channels.size === 0) groupListeners.delete(listener);
	};
}
