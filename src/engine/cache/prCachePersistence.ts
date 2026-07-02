import type { PrCacheState } from "./prCache.js";
import { readJsonFile, writeJsonFileAtomic } from "../jsonFile.js";

const EMPTY_STATE: PrCacheState = { effects: [], embeddings: [] };

function isPrCacheState(value: unknown): value is PrCacheState {
	return (
		typeof value === "object" &&
		value !== null &&
		"effects" in value &&
		Array.isArray((value as Record<string, unknown>)["effects"]) &&
		"embeddings" in value &&
		Array.isArray((value as Record<string, unknown>)["embeddings"])
	);
}

export async function loadState(path: string): Promise<PrCacheState> {
	return (await readJsonFile(path, isPrCacheState)) ?? EMPTY_STATE;
}

export async function saveState(path: string, state: PrCacheState): Promise<void> {
	await writeJsonFileAtomic(path, state);
}
