import type { DecidedPrState } from "../types/decided.js";
import { readJsonFile, writeJsonFileAtomic } from "../jsonFile.js";

const EMPTY_STATE: DecidedPrState = { entries: [] };

function isDecidedPrState(value: unknown): value is DecidedPrState {
	return (
		typeof value === "object" &&
		value !== null &&
		"entries" in value &&
		Array.isArray((value as Record<string, unknown>)["entries"])
	);
}

export async function loadState(path: string): Promise<DecidedPrState> {
	return (await readJsonFile(path, isDecidedPrState)) ?? EMPTY_STATE;
}

export async function saveState(path: string, state: DecidedPrState): Promise<void> {
	await writeJsonFileAtomic(path, state);
}
