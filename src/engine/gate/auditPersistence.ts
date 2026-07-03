import type { AuditState } from "../types/audit.js";
import { readJsonFile, writeJsonFileAtomic } from "../jsonFile.js";

const EMPTY_STATE: AuditState = { entries: [] };

function isAuditState(value: unknown): value is AuditState {
	return (
		typeof value === "object" &&
		value !== null &&
		"entries" in value &&
		Array.isArray((value as Record<string, unknown>)["entries"])
	);
}

export async function loadState(path: string): Promise<AuditState> {
	return (await readJsonFile(path, isAuditState)) ?? EMPTY_STATE;
}

export async function saveState(path: string, state: AuditState): Promise<void> {
	await writeJsonFileAtomic(path, state);
}
