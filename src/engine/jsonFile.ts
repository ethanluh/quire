import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { createKeyedLock } from "./util/keyedLock.js";

// Shared by every module that persists a bit of state to a single JSON file: on-disk
// account, merge queue, decided-PR record. Reads validate via a caller-supplied type guard
// and treat a missing or corrupted file as "nothing persisted yet" rather than an error;
// writes go through a temp-file-then-rename so a crash mid-write can't leave a truncated
// file behind.

export async function readJsonFile<T>(path: string, isValid: (value: unknown) => value is T): Promise<T | undefined> {
	if (!existsSync(path)) return undefined;
	let raw: string;
	try {
		raw = await readFile(path, "utf8");
	} catch (err) {
		console.warn(`readJsonFile: failed to read ${path}, treating as absent:`, err);
		return undefined;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		console.warn(`readJsonFile: ${path} contains invalid JSON, treating as absent:`, err);
		return undefined;
	}
	if (isValid(parsed)) return parsed;
	console.warn(`readJsonFile: ${path} failed its schema guard, treating as absent`);
	return undefined;
}

// Ensures the parent directory of `path` exists (recursively), so a subsequent write to
// `path` can't fail on a missing dir. Shared by writeJsonFileAtomic and the NDJSON append
// path in instrumentation/store.ts, which need the identical guarantee.
export async function ensureDir(path: string): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
}

// Two overlapping writes to the *same* path (e.g. two teammates' requests both saving a
// team's queue.json) must never race: each gets its own temp file (unique suffix) so a
// concurrent writer can't clobber another's in-flight tmp file, and the writes themselves
// are serialized per path so the rename that lands last is deterministically the write that
// was *issued* last — not whichever happened to win the fs race. Mirrors the per-key
// promise-chain pattern already used for refresh coalescing (refreshRepoQueue.ts).
const writeLock = createKeyedLock();

export async function writeJsonFileAtomic(path: string, data: unknown): Promise<void> {
	await writeLock(path, async () => {
		await ensureDir(path);
		const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
		await writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
		await rename(tmp, path);
	});
}
