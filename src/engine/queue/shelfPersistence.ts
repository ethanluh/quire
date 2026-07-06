import type { ShelfState } from "../types/shelf.js";
import { createJsonStatePersistence } from "../util/jsonStatePersistence.js";

const EMPTY_STATE: ShelfState = { entries: [] };

function isShelfState(value: unknown): value is ShelfState {
	return (
		typeof value === "object" &&
		value !== null &&
		"entries" in value &&
		Array.isArray((value as Record<string, unknown>)["entries"])
	);
}

export const { loadState, saveState } = createJsonStatePersistence<ShelfState>(isShelfState, EMPTY_STATE);
