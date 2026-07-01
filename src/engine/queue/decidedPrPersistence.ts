import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import type { DecidedPrState } from "../types/decided.js";

const EMPTY_STATE: DecidedPrState = { entries: [] };

export async function loadState(path: string): Promise<DecidedPrState> {
	if (!existsSync(path)) return EMPTY_STATE;
	try {
		const raw = await readFile(path, "utf8");
		const parsed: unknown = JSON.parse(raw);
		if (
			typeof parsed === "object" &&
			parsed !== null &&
			"entries" in parsed &&
			Array.isArray((parsed as Record<string, unknown>)["entries"])
		) {
			return parsed as DecidedPrState;
		}
	} catch {
		// corrupted file — start fresh
	}
	return EMPTY_STATE;
}

export async function saveState(path: string, state: DecidedPrState): Promise<void> {
	const dir = dirname(path);
	await mkdir(dir, { recursive: true });
	const tmp = `${path}.tmp`;
	await writeFile(tmp, JSON.stringify(state, null, 2), "utf8");
	await rename(tmp, path);
}
