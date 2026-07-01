import { describe, it, expect, afterEach } from "@jest/globals";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendNdjson, truncateNdjson, readNdjson } from "../../src/engine/instrumentation/store.js";

describe("truncateNdjson", () => {
	let dir: string;

	afterEach(async () => {
		if (dir) await rm(dir, { recursive: true, force: true });
	});

	it("empties a file that already has ndjson records", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-store-"));
		const path = join(dir, "defers.ndjson");
		await appendNdjson(path, { a: 1 });
		await appendNdjson(path, { a: 2 });

		await truncateNdjson(path);

		expect(await readFile(path, "utf8")).toBe("");
	});

	it("creates the file (and parent dirs) when nothing existed before", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-store-"));
		const path = join(dir, "nested", "defers.ndjson");

		await truncateNdjson(path);

		expect(await readFile(path, "utf8")).toBe("");
	});
});

describe("readNdjson", () => {
	let dir: string;

	afterEach(async () => {
		if (dir) await rm(dir, { recursive: true, force: true });
	});

	it("parses each line back into a record, in order", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-store-"));
		const path = join(dir, "defers.ndjson");
		await appendNdjson(path, { a: 1 });
		await appendNdjson(path, { a: 2 });

		expect(await readNdjson<{ a: number }>(path)).toEqual([{ a: 1 }, { a: 2 }]);
	});

	it("returns an empty array when the file does not exist", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-store-"));
		const path = join(dir, "missing.ndjson");

		expect(await readNdjson(path)).toEqual([]);
	});
});
