import type { PrCacheState } from "./prCache.js";
import { readJsonFile, writeJsonFileAtomic } from "../jsonFile.js";

const EMPTY_STATE: PrCacheState = { effects: [], embeddings: [] };

function isPrCacheState(value: unknown): value is PrCacheState {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Record<string, unknown>;
	return (
		"effects" in record &&
		Array.isArray(record["effects"]) &&
		"embeddings" in record &&
		Array.isArray(record["embeddings"])
	);
}

export async function loadState(path: string): Promise<PrCacheState> {
	return (await readJsonFile(path, isPrCacheState)) ?? EMPTY_STATE;
}

export async function saveState(path: string, state: PrCacheState): Promise<void> {
	await writeJsonFileAtomic(path, state);
}
