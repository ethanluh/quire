import { describe, it, expect, afterEach } from "@jest/globals";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPreferences, savePreferences } from "../../src/engine/github/preferences.js";
import type { StoredPreferences } from "../../src/engine/github/preferences.js";

describe("github preferences persistence", () => {
	let dir: string;

	afterEach(async () => {
		if (dir) await rm(dir, { recursive: true, force: true });
	});

	it("returns an empty object when no preferences file exists", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-preferences-"));
		const preferences = await loadPreferences(join(dir, "preferences.json"));
		expect(preferences).toEqual({});
	});

	it("round-trips saved preferences, creating parent dirs as needed", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-preferences-"));
		const path = join(dir, "nested", "preferences.json");
		const preferences: StoredPreferences = {
			selectedRepo: { owner: "acme-corp", name: "widgets" },
			autoMergeOnAccept: true,
		};

		await savePreferences(path, preferences);
		const loaded = await loadPreferences(path);

		expect(loaded).toEqual(preferences);
	});

	it("treats a corrupted file as no stored preferences", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-preferences-"));
		const path = join(dir, "preferences.json");
		await writeFile(path, "not json", "utf8");

		const loaded = await loadPreferences(path);

		expect(loaded).toEqual({});
	});
});
