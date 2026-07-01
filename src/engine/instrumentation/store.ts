import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export async function appendNdjson(path: string, record: unknown): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await appendFile(path, JSON.stringify(record) + "\n", "utf8");
}

export async function truncateNdjson(path: string): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, "", "utf8");
}

export async function readNdjson<T>(path: string): Promise<T[]> {
	let raw: string;
	try {
		raw = await readFile(path, "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw err;
	}
	return raw
		.split("\n")
		.filter((line) => line.trim() !== "")
		.map((line) => JSON.parse(line) as T);
}
