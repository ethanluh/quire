import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export async function appendNdjson(path: string, record: unknown): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await appendFile(path, JSON.stringify(record) + "\n", "utf8");
}

export async function truncateNdjson(path: string): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, "", "utf8");
}
