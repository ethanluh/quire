import type { QueueState } from "../types/queue.js";
import { readJsonFile, writeJsonFileAtomic } from "../jsonFile.js";

const EMPTY_STATE: QueueState = { entries: [] };

function isQueueState(value: unknown): value is QueueState {
	return (
		typeof value === "object" &&
		value !== null &&
		"entries" in value &&
		Array.isArray((value as Record<string, unknown>)["entries"])
	);
}

export async function loadState(path: string): Promise<QueueState> {
	const state = await readJsonFile(path, isQueueState);
	if (state === undefined) return EMPTY_STATE;
	// Older persisted entries predate mergedPrIds - default it so dequeueNext() doesn't
	// crash on .includes() against a missing field.
	return { entries: state.entries.map((e) => ({ ...e, mergedPrIds: e.mergedPrIds ?? [] })) };
}

export async function saveState(path: string, state: QueueState): Promise<void> {
	await writeJsonFileAtomic(path, state);
}
