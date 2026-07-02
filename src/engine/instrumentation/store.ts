import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname } from "node:path";

// Assumes sequential callers (e.g. one await per write, as every current caller does) —
// concurrent appendFile calls to the same path can interleave and corrupt a line.
export async function appendNdjson(path: string, record: unknown): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await appendFile(path, JSON.stringify(record) + "\n", "utf8");
}

export async function truncateNdjson(path: string): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, "", "utf8");
}

// Rewrites the whole log from a full snapshot of its records, for logs that need to
// mutate an existing row (e.g. recording an overturn) rather than only ever append —
// NDJSON has no in-place update, so a mutation is a full rewrite instead of a single line.
export async function writeNdjson<T>(path: string, records: ReadonlyArray<T>): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const content = records.map((record) => JSON.stringify(record)).join("\n");
	await writeFile(path, content.length > 0 ? content + "\n" : "", "utf8");
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
