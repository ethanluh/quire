import type { QueueState } from "../types/queue.js";
import { createJsonStatePersistence } from "../util/jsonStatePersistence.js";

const EMPTY_STATE: QueueState = { entries: [] };

function isQueueState(value: unknown): value is QueueState {
	return (
		typeof value === "object" &&
		value !== null &&
		"entries" in value &&
		Array.isArray((value as Record<string, unknown>)["entries"])
	);
}

// Older persisted entries predate mergedPrIds - default it so dequeueNext() doesn't
// crash on .includes() against a missing field.
export const { loadState, saveState } = createJsonStatePersistence<QueueState>(
	isQueueState,
	EMPTY_STATE,
	(state) => ({ entries: state.entries.map((e) => ({ ...e, mergedPrIds: e.mergedPrIds ?? [] })) }),
);
