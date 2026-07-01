import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname } from "node:path";

// Shared by every module that persists a bit of state to a single JSON file: on-disk
// account, merge queue, decided-PR record. Reads validate via a caller-supplied type guard
// and treat a missing or corrupted file as "nothing persisted yet" rather than an error;
// writes go through a temp-file-then-rename so a crash mid-write can't leave a truncated
// file behind.

export async function readJsonFile<T>(path: string, isValid: (value: unknown) => value is T): Promise<T | undefined> {
	if (!existsSync(path)) return undefined;
	try {
		const raw = await readFile(path, "utf8");
		const parsed: unknown = JSON.parse(raw);
		if (isValid(parsed)) return parsed;
	} catch {
		// corrupted file — treat as absent
	}
	return undefined;
}

export async function writeJsonFileAtomic(path: string, data: unknown): Promise<void> {
	const dir = dirname(path);
	await mkdir(dir, { recursive: true });
	const tmp = `${path}.tmp`;
	await writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
	await rename(tmp, path);
}
