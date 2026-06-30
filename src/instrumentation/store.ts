import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export async function appendNdjson(path: string, record: unknown): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await appendFile(path, JSON.stringify(record) + "\n", "utf8");
}
