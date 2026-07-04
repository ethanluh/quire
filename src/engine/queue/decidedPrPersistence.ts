import type { DecidedPrState } from "../types/decided.js";
import { createJsonStatePersistence } from "../util/jsonStatePersistence.js";

const EMPTY_STATE: DecidedPrState = { entries: [] };

function isDecidedPrState(value: unknown): value is DecidedPrState {
	return (
		typeof value === "object" &&
		value !== null &&
		"entries" in value &&
		Array.isArray((value as Record<string, unknown>)["entries"])
	);
}

export const { loadState, saveState } = createJsonStatePersistence<DecidedPrState>(isDecidedPrState, EMPTY_STATE);
