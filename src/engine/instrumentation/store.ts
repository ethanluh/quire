import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname } from "node:path";

async function ensureDir(path: string): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
}

// Assumes sequential callers (e.g. one await per write, as every current caller does) —
// concurrent appendFile calls to the same path can interleave and corrupt a line.
export async function appendNdjson(path: string, record: unknown): Promise<void> {
	await ensureDir(path);
	await appendFile(path, JSON.stringify(record) + "\n", "utf8");
}

export async function truncateNdjson(path: string): Promise<void> {
	await ensureDir(path);
	await writeFile(path, "", "utf8");
}

export async function readNdjson<T>(path: string): Promise<T[]> {
	if (!existsSync(path)) return [];
	const raw = await readFile(path, "utf8");
	const records: T[] = [];
	for (const line of raw.split("\n")) {
		const trimmed = line.trim();
		if (trimmed.length === 0) continue;
		try {
			records.push(JSON.parse(trimmed) as T);
		} catch {
			// corrupted line (e.g. a write truncated mid-append) — skip it and keep
			// loading the rest of the log rather than failing startup entirely.
		}
	}
	return records;
}
