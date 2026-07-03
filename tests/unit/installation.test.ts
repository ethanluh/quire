import { describe, it, expect, afterEach } from "@jest/globals";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadInstallation, saveInstallation, clearInstallation } from "../../src/engine/github/installation.js";
import type { InstallationAccountState, InstallationBinding } from "../../src/engine/github/installation.js";

const BINDING_A: InstallationBinding = {
	installationId: 42,
	accountLogin: "octocat",
	accountType: "Organization",
	boundAt: "2026-06-30T00:00:00.000Z",
};

const BINDING_B: InstallationBinding = {
	installationId: 43,
	accountLogin: "acme-corp",
	accountType: "Organization",
	boundAt: "2026-06-30T00:00:00.000Z",
};

describe("github installation persistence", () => {
	let dir: string;

	afterEach(async () => {
		if (dir) await rm(dir, { recursive: true, force: true });
	});

	it("returns undefined when no installation file exists", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-installation-"));
		const state = await loadInstallation(join(dir, "installation.json"));
		expect(state).toBeUndefined();
	});

	it("round-trips a saved single-installation state, creating parent dirs as needed", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-installation-"));
		const path = join(dir, "nested", "installation.json");
		const state: InstallationAccountState = { installations: [BINDING_A] };

		await saveInstallation(path, state);
		const loaded = await loadInstallation(path);

		expect(loaded).toEqual(state);
	});

	it("round-trips multiple bound installations plus a selected repo and autoMergeOnAccept", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-installation-"));
		const path = join(dir, "installation.json");
		const state: InstallationAccountState = {
			installations: [BINDING_A, BINDING_B],
			selectedRepo: { owner: "acme-corp", name: "widgets", installationId: 43 },
			autoMergeOnAccept: true,
		};

		await saveInstallation(path, state);
		const loaded = await loadInstallation(path);

		expect(loaded).toEqual(state);
	});

	it("treats a corrupted file as not connected", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-installation-"));
		const path = join(dir, "installation.json");
		await saveInstallation(path, { installations: [BINDING_A] });
		await rm(path);
		await writeFile(path, "not json", "utf8");

		const loaded = await loadInstallation(path);

		expect(loaded).toBeUndefined();
	});

	it("treats the old pre-multi-installation single-binding shape as not connected (no migration path)", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-installation-"));
		const path = join(dir, "installation.json");
		await writeFile(path, JSON.stringify(BINDING_A), "utf8");

		const loaded = await loadInstallation(path);

		expect(loaded).toBeUndefined();
	});

	it("clearInstallation removes the file without throwing if it never existed", async () => {
		dir = await mkdtemp(join(tmpdir(), "quire-installation-"));
		const path = join(dir, "installation.json");
		await saveInstallation(path, { installations: [BINDING_A] });

		await clearInstallation(path);
		await expect(clearInstallation(path)).resolves.toBeUndefined();
		expect(await loadInstallation(path)).toBeUndefined();
	});
});
