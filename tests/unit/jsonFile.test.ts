import { describe, it, expect, afterEach } from "@jest/globals";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readJsonFile, writeJsonFileAtomic } from "../../src/engine/jsonFile.js";

interface Payload {
	value: string;
}

function isPayload(value: unknown): value is Payload {
	return typeof value === "object" && value !== null && typeof (value as Payload).value === "string";
}

describe("writeJsonFileAtomic", () => {
	let dir: string;

	afterEach(async () => {
		if (dir !== undefined) await rm(dir, { recursive: true, force: true });
	});

	it("does not let two concurrent writes to the same path clobber each other's temp file", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-jsonfile-"));
		const path = join(dir, "state.json");

		// Fire both writes together; the second call is issued after the first (per
		// writeJsonFileAtomic's per-path serialization) so it must be the one that survives —
		// never a partial mix of the two payloads, and never silently lost.
		const first = writeJsonFileAtomic(path, { value: "first" });
		const second = writeJsonFileAtomic(path, { value: "second" });
		await Promise.all([first, second]);

		const result = await readJsonFile(path, isPayload);
		expect(result).toEqual({ value: "second" });
	});

	it("serializes many concurrent writers to the same path without losing the last one", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-jsonfile-"));
		const path = join(dir, "state.json");

		const writes = Array.from({ length: 20 }, (_, i) => writeJsonFileAtomic(path, { value: `write-${i}` }));
		await Promise.all(writes);

		const result = await readJsonFile(path, isPayload);
		expect(result).toEqual({ value: "write-19" });
	});
});
